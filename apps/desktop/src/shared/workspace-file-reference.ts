const WINDOWS_DRIVE_ABSOLUTE_PATTERN = /^[a-z]:[\\/]/iu;
const WINDOWS_UNC_ABSOLUTE_PATTERN = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/u;

export const isAbsoluteWorkspaceFileReference = (
  value: string,
): boolean =>
  value.startsWith('/') ||
  WINDOWS_DRIVE_ABSOLUTE_PATTERN.test(value) ||
  WINDOWS_UNC_ABSOLUTE_PATTERN.test(value);

