import type { DeferredEntity } from '@backstage/plugin-catalog-backend';
import {
  INCREMENTAL_ENTITY_PROVIDER_ANNOTATION,
  IterationEngine,
  IterationEngineOptions,
} from '../types';
import { IncrementalIngestionDatabaseManager } from '../database/IncrementalIngestionDatabaseManager';

import { performance } from 'perf_hooks';
import { Duration, DurationObjectUnits } from 'luxon';
import { v4 } from 'uuid';

export class IncrementalIngestionEngine implements IterationEngine {
  restLength: Duration;
  backoff: DurationObjectUnits[];

  private manager: IncrementalIngestionDatabaseManager;

  constructor(private options: IterationEngineOptions) {
    this.manager = options.manager;
    this.restLength = Duration.fromObject(options.restLength);
    this.backoff = options.backoff ?? [
      { minutes: 1 },
      { minutes: 5 },
      { minutes: 30 },
      { hours: 3 },
    ];
  }

  async taskFn(signal: AbortSignal) {
    try {
      this.options.logger.debug('Begin tick');
      await this.handleNextAction(signal);
    } catch (error) {
      this.options.logger.error(`${error}`);
      throw error;
    } finally {
      this.options.logger.debug('End tick');
    }
  }

  async handleNextAction(signal: AbortSignal) {
    await this.options.ready;

    const result = await this.getCurrentAction();
    if (result) {
      const { ingestionId, nextActionAt, nextAction, attempts } = result;

      switch (nextAction) {
        case 'rest':
          if (Date.now() > nextActionAt) {
            await this.manager.clearFinishedIngestions(
              this.options.provider.getProviderName(),
            );
            this.options.logger.info(
              `incremental-engine: Ingestion ${ingestionId} rest period complete. Ingestion will start again`,
            );

            await this.manager.setProviderComplete(ingestionId);
          } else {
            this.options.logger.info(
              `incremental-engine: Ingestion '${ingestionId}' rest period continuing`,
            );
          }
          break;
        case 'ingest':
          try {
            await this.manager.setProviderBursting(ingestionId);
            const done = await this.ingestOneBurst(ingestionId, signal);
            if (done) {
              this.options.logger.info(
                `incremental-engine: Ingestion '${ingestionId}' complete, transitioning to rest period of ${this.restLength.toHuman()}`,
              );
              await this.manager.setProviderResting(
                ingestionId,
                this.restLength,
              );
            } else {
              await this.manager.setProviderInterstitial(ingestionId);
              this.options.logger.info(
                `incremental-engine: Ingestion '${ingestionId}' continuing`,
              );
            }
          } catch (error) {
            if (
              (error as Error).message &&
              (error as Error).message === 'CANCEL'
            ) {
              this.options.logger.info(
                `incremental-engine: Ingestion '${ingestionId}' canceled`,
              );
              await this.manager.setProviderCanceling(
                ingestionId,
                (error as Error).message,
              );
            } else {
              const currentBackoff = Duration.fromObject(
                this.backoff[Math.min(this.backoff.length - 1, attempts)],
              );

              const backoffLength = currentBackoff.as('milliseconds');
              this.options.logger.error(error);

              const truncatedError = typeof error === 'string' ? error.substring(0, 700) : `${error}`;
              this.options.logger.error(
                `incremental-engine: Ingestion '${ingestionId}' threw an error during ingestion burst. Ingestion will backoff for ${currentBackoff.toHuman()} (${truncatedError})`,
              );

              await this.manager.setProviderBackoff(
                ingestionId,
                attempts,
                error as Error,
                backoffLength,
              );
            }
          }
          break;
        case 'backoff':
          if (Date.now() > nextActionAt) {
            this.options.logger.info(
              `incremental-engine: Ingestion '${ingestionId}' backoff complete, will attempt to resume`,
            );
            await this.manager.setProviderIngesting(ingestionId);
          } else {
            this.options.logger.info(
              `incremental-engine: Ingestion '${ingestionId}' backoff continuing`,
            );
          }
          break;
        case 'cancel':
          this.options.logger.info(
            `incremental-engine: Ingestion '${ingestionId}' canceling, will restart`,
          );
          await this.manager.setProviderCanceled(ingestionId);
          break;
        default:
          this.options.logger.error(
            `incremental-engine: Ingestion '${ingestionId}' received unknown action '${nextAction}'`,
          );
      }
    } else {
      this.options.logger.error(
        `incremental-engine: Engine tried to create duplicate ingestion record for provider '${this.options.provider.getProviderName()}'.`,
      );
    }
  }

  async getCurrentAction() {
    const providerName = this.options.provider.getProviderName();
    const record = await this.manager.getCurrentIngestionRecord(providerName);
    if (record) {
      this.options.logger.info(
        `incremental-engine: Ingestion record found: '${record.id}'`,
      );
      return {
        ingestionId: record.id,
        nextAction: record.next_action as 'rest' | 'ingest' | 'backoff',
        attempts: record.attempts as number,
        nextActionAt: record.next_action_at.valueOf() as number,
      };
    }
    const result = await this.manager.createProviderIngestionRecord(
      providerName,
    );
    if (result) {
      this.options.logger.info(
        `incremental-engine: Ingestion record created: '${result.ingestionId}'`,
      );
    }
    return result;
  }

  async ingestOneBurst(id: string, signal: AbortSignal) {
    const lastMark = await this.manager.getLastMark(id);

    const cursor = lastMark ? lastMark.cursor : void 0;
    let sequence = lastMark ? lastMark.sequence + 1 : 0;

    const start = performance.now();
    let count = 0;
    let done = false;
    this.options.logger.info(
      `incremental-engine: Ingestion '${id}' burst initiated`,
    );

    await this.options.provider.around(async (context: unknown) => {
      let next = await this.options.provider.next(context, cursor);
      count++;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        done = next.done;
        await this.mark(id, sequence, next.entities, next.done, next.cursor);
        if (signal.aborted || next.done) {
          break;
        } else {
          next = await this.options.provider.next(context, next.cursor);
          count++;
          sequence++;
        }
      }
    });

    this.options.logger.info(
      `incremental-engine: Ingestion '${id}' burst complete. (${count} batches in ${Math.round(
        performance.now() - start,
      )}ms).`,
    );
    return done;
  }

  async mark(
    id: string,
    sequence: number,
    entities: DeferredEntity[],
    done: boolean,
    cursor?: unknown,
  ) {
    this.options.logger.debug(
      `incremental-engine: Ingestion '${id}': MARK ${
        entities.length
      } entities, cursor: ${JSON.stringify(cursor)}, done: ${done}`,
    );
    const markId = v4();

    await this.manager.createMark({
      record: {
        id: markId,
        ingestion_id: id,
        cursor,
        sequence,
      },
    });

    if (entities.length > 0) {
      await this.manager.createMarkEntities(markId, entities);
    }

    const added = entities.map(deferred => ({
      ...deferred,
      entity: {
        ...deferred.entity,
        metadata: {
          ...deferred.entity.metadata,
          annotations: {
            ...deferred.entity.metadata.annotations,
            [INCREMENTAL_ENTITY_PROVIDER_ANNOTATION]:
              this.options.provider.getProviderName(),
          },
        },
      },
    }));

    const removed: DeferredEntity[] = done
      ? []
      : await this.manager.computeRemoved(
          this.options.provider.getProviderName(),
          id,
        );

    await this.options.connection.applyMutation({
      type: 'delta',
      added,
      removed,
    });
  }
}
