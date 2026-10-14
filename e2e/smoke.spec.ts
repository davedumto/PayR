import { expect, test, type Page } from "@playwright/test";

const ROUTES = [
  { path: "/dashboard", heading: "Overview" },
  { path: "/dashboard/paywalls", heading: "Paywalls" },
  { path: "/dashboard/paywalls/new", heading: "New paywall" },
  { path: "/dashboard/settlements", heading: "Settlements" },
  { path: "/dashboard/security", heading: "Security" },
  { path: "/dashboard/settings", heading: "Settings" },
] as const;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

async function hasNoHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

test.describe("dashboard shell", () => {
  for (const route of ROUTES) {
    test(`renders ${route.path} in the shell`, async ({ page }) => {
      await page.goto(route.path);
      await expect(page.getByRole("heading", { level: 1, name: route.heading })).toBeVisible();
      // Desktop keeps the sidebar mounted; mobile renders nav only inside the open drawer.
      if (test.info().project.name === "desktop") {
        await expect(
          page.locator("aside").getByRole("navigation", { name: "Primary" }),
        ).toBeVisible();
      } else {
        await expect(page.getByRole("button", { name: "Menu" })).toBeVisible();
      }
      await expect(page.getByRole("status").first()).toContainText(/Testnet|Payments/);
      expect(await hasNoHorizontalScroll(page)).toBe(true);
    });
  }

  test("marks the active nav item with aria-current and no filled highlight", async ({ page }) => {
    await page.goto("/dashboard/paywalls/new");
    const active = page.locator('a[aria-current="page"]');
    await expect(active).toHaveCount(1);
    await expect(active).toHaveText("Paywalls");
  });
});

test("makes no requests to third-party hosts", async ({ page }) => {
  const hosts = new Set<string>();
  page.on("request", (request) => {
    hosts.add(new URL(request.url()).hostname);
  });

  for (const route of ROUTES) {
    await page.goto(route.path);
    await page.waitForLoadState("networkidle");
  }

  const thirdParty = [...hosts].filter((host) => !LOCAL_HOSTS.has(host));
  expect(thirdParty).toEqual([]);
});

test("mobile drawer: keyboard open, focus trap, Escape, focus restore", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "drawer applies below md only");

  await page.goto("/dashboard");
  const menu = page.getByRole("button", { name: "Menu" });
  await menu.focus();
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Navigation" });
  await expect(dialog).toBeVisible();
  // Focus moves into the drawer when it opens.
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();

  // Tab cycles within the drawer and never reaches the page behind it.
  const links = dialog.getByRole("link");
  const linkCount = await links.count();
  for (let i = 0; i < linkCount + 3; i++) {
    await page.keyboard.press("Tab");
    const insideDialog = await page.evaluate(() =>
      Boolean(document.activeElement?.closest('[role="dialog"]')),
    );
    expect(insideDialog).toBe(true);
  }

  // Shift+Tab from the first control wraps to the last.
  await dialog.getByRole("button", { name: "Close" }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(links.last()).toBeFocused();

  // Escape closes and focus returns to the opener.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(menu).toBeFocused();
});

test("mobile drawer: activating a link navigates and closes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "drawer applies below md only");

  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("dialog").getByRole("link", { name: "Settlements" }).click();
  await expect(page).toHaveURL(/\/dashboard\/settlements$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("desktop shows the persistent sidebar and hides the drawer trigger", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop layout only");

  await page.goto("/dashboard");
  await expect(page.locator("aside").getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Menu" })).toBeHidden();
});

test("mobile: page content is inert while the drawer is open", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "drawer applies below md only");

  await page.goto("/dashboard");
  // inert is inherited from the wrapper, so check for an inert ancestor, not the element itself.
  const inertState = () =>
    page.evaluate(() => document.getElementById("main")?.closest("[inert]") !== null);

  expect(await inertState()).toBe(false);
  await page.getByRole("button", { name: "Menu" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await inertState()).toBe(true);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await inertState()).toBe(false);
});
