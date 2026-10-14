import { rename, rm, writeFile } from "node:fs/promises";

/**
 * Writes via a sibling temp file and renames it into place, so a crash mid-write
 * leaves the previous complete file rather than a truncated one.
 */
export const writeFileAtomic = async (
  path: string,
  contents: string,
): Promise<void> => {
  const tempPath = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tempPath, contents, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
};
