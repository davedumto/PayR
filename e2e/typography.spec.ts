import { expect, test } from "@playwright/test";

// Renders digit strings in the app's body font (Inter) and measures them in a real
// browser. Tabular figures must give every digit the same advance, so "1111" and
// "0000" have equal width. The negative control proves the measurement can fail.
test("Inter renders digits with equal width under tabular-nums", async ({ page }) => {
  await page.goto("/dashboard");
  await page.evaluate(() => document.fonts.ready);

  const widths = await page.evaluate(async () => {
    const measure = (text: string, numeric: "tabular" | "default") => {
      const span = document.createElement("span");
      span.textContent = text;
      span.style.whiteSpace = "nowrap";
      span.style.fontSize = "48px";
      // Inherits the body font (Inter) and the :root tabular-nums rule, so this
      // measures what the product actually renders.
      span.style.fontVariantNumeric = numeric === "tabular" ? "tabular-nums" : "normal";
      document.body.appendChild(span);
      const width = span.getBoundingClientRect().width;
      span.remove();
      return width;
    };
    const family = getComputedStyle(document.body).fontFamily;
    const loaded = [...document.fonts].some(
      (face) => face.status === "loaded" && /inter/i.test(face.family),
    );
    return {
      family,
      loaded,
      tabularOnes: measure("1111", "tabular"),
      tabularZeros: measure("0000", "tabular"),
      defaultOnes: measure("1111", "default"),
      defaultZeros: measure("0000", "default"),
    };
  });

  expect(widths.loaded, `Inter should be loaded (body font: ${widths.family})`).toBe(true);
  expect(Math.abs(widths.tabularOnes - widths.tabularZeros)).toBeLessThan(0.01);
  // Negative control: without tabular figures, Inter's proportional "1" is narrower.
  expect(Math.abs(widths.defaultOnes - widths.defaultZeros)).toBeGreaterThan(1);
});
