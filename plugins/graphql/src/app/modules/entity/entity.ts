import { resolvePackagePath } from '@backstage/backend-common';
import { CompoundEntityRef, stringifyEntityRef } from '@backstage/catalog-model';
import { loadFilesSync } from '@graphql-tools/load-files';
import { createModule } from 'graphql-modules';

export const Entity = createModule({
  id: 'entity',
  typeDefs: loadFilesSync(resolvePackagePath('@frontside/backstage-plugin-graphql', 'src/app/modules/entity/entity.graphql')),
  resolvers: {
    Query: {
      entity: (
        _: any,
        { name, kind, namespace = 'default' }: CompoundEntityRef,
      ): { id: string } => ({ id: stringifyEntityRef({ name, kind, namespace }) }),
    },
  },
});
