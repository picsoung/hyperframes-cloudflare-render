// Type declaration for the generated composition-manifest.json. The actual
// file is produced by scripts/build.mjs at dev/deploy time and is gitignored,
// so on a fresh clone (before the first build) `tsc` would otherwise fail to
// resolve the import in src/index.ts. This declaration makes typecheck happy
// without committing the generated artifact.

declare module "*/composition-manifest.json" {
  const manifest: {
    dir: string;
    files: string[];
  };
  export default manifest;
}
