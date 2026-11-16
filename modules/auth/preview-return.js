// Shared, provider-independent auth return routing for the latest LOKAL AI app.
export function resolveAuthReturnContext({
  previewMode = false,
  hash = "",
  historyState = null,
  authReturnToPreview = false,
  storedPreview = false,
  activePage = "",
  storedPage = "",
  queryPage = "",
  queryReturn = ""
} = {}) {
  const hashPage = hash.startsWith("#preview-") ? hash.slice("#preview-".length) : "";
  const preview = Boolean(
    previewMode ||
    authReturnToPreview ||
    historyState?.lokalAuthReturnToPreview ||
    historyState?.lokalRoute === "preview" ||
    storedPreview ||
    queryReturn === "preview" ||
    hashPage
  );
  const page = [
    activePage,
    historyState?.lokalAuthReturnPage,
    queryPage,
    storedPage,
    hashPage,
    historyState?.lokalWorkspacePage
  ].find(value => typeof value === "string" && value.trim()) || "home";
  return { preview, page };
}

export function buildAuthRedirectUrl({ origin, pathname, preview, page = "home" }) {
  const url = new URL(pathname || "/", origin);
  if (preview) {
    url.searchParams.set("lokal_return", "preview");
    url.searchParams.set("lokal_page", page || "home");
  }
  return url.toString();
}
