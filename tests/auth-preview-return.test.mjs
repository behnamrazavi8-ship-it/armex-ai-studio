import test from "node:test";
import assert from "node:assert/strict";
import { buildAuthRedirectUrl, resolveAuthReturnContext } from "../modules/auth/preview-return.js";

test("password sign-in preserves the active preview page", () => {
  assert.deepEqual(resolveAuthReturnContext({
    previewMode: true,
    hash: "#preview-image",
    activePage: "image"
  }), { preview: true, page: "image" });
});

test("Google OAuth callback restores the saved preview page", () => {
  assert.deepEqual(resolveAuthReturnContext({
    hash: "#top",
    storedPreview: true,
    storedPage: "chat",
    queryPage: "chat"
  }), { preview: true, page: "chat" });
});

test("auth redirect URL carries preview context for OAuth and email confirmation", () => {
  const url = new URL(buildAuthRedirectUrl({
    origin: "https://feat-chat-module-on-latest-a.armex-ai-studio.pages.dev",
    pathname: "/",
    preview: true,
    page: "image"
  }));
  assert.equal(url.searchParams.get("lokal_return"), "preview");
  assert.equal(url.searchParams.get("lokal_page"), "image");
});

test("ordinary production workspace login does not become preview", () => {
  assert.deepEqual(resolveAuthReturnContext({
    hash: "#workspace-home",
    historyState: { lokalRoute: "workspace", lokalWorkspacePage: "home" }
  }), { preview: false, page: "home" });
});

test("OAuth callback query marker restores preview after a fresh page bootstrap", () => {
  assert.deepEqual(resolveAuthReturnContext({
    hash: "#top",
    queryReturn: "preview",
    queryPage: "video"
  }), { preview: true, page: "video" });
});

test("authenticated preview refresh remains in preview from the URL marker", () => {
  assert.deepEqual(resolveAuthReturnContext({
    hash: "#preview-chat",
    historyState: { lokalRoute: "preview", lokalWorkspacePage: "chat" },
    queryReturn: "preview",
    queryPage: "chat"
  }), { preview: true, page: "chat" });
});
