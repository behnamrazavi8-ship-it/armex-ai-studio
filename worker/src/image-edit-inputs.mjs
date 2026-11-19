export function getImageEditInputPaths(job) {
  const paths = Array.isArray(job?.input_storage_paths) && job.input_storage_paths.length
    ? job.input_storage_paths
    : [job?.input_storage_path];
  const userId = String(job?.user_id || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId) || paths.length < 1 || paths.length > 3) {
    throw new Error("IMAGE_EDIT_INPUT_COUNT_OR_PATH_INVALID");
  }
  const prefix = userId + "/edit/";
  for (const path of paths) {
    if (typeof path !== "string" || !path.startsWith(prefix) ||
        path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error("IMAGE_EDIT_INPUT_COUNT_OR_PATH_INVALID");
    }
  }
  return paths;
}
