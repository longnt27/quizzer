import { join } from 'node:path';

export const seaLanceDbPlugin = projectDirectory => ({
  name: 'quizzer-embedded-lancedb',
  setup(buildContext) {
    buildContext.onResolve({ filter: /^(?:\.\.\/|\.\/)native(?:\.js)?$/ }, args => {
      const importer = args.importer.replaceAll('\\', '/');
      if (!importer.includes('node_modules/@lancedb/lancedb/dist/')) return undefined;
      return { path: join(projectDirectory, 'scripts', 'sea-lancedb-native.cjs') };
    });
  },
});
