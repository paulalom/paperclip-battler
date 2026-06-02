import { expect, test, type Browser, type BrowserContext, type FrameLocator, type Page } from "@playwright/test";

const APP_URL = "http://127.0.0.1:5174";

test("human players see paperclip updates after switching between host and client sessions", async ({ browser }) => {
  const hostContext = await newSession(browser);
  const clientContext = await newSession(browser);

  try {
    const hostPage = await hostContext.newPage();
    const clientPage = await clientContext.newPage();

    await test.step("create a host room", async () => {
      await hostPage.goto("/");
      await hostPage.getByTitle("Create room").click();
      await expect(hostPage).toHaveURL(/\/rooms\/[a-z0-9-]+$/);
      await expect(playerPane(hostPage, "Player 1 (you)")).toBeVisible();
    });

    const roomId = currentRoomId(hostPage);

    await test.step("join the room as the second player", async () => {
      await clientPage.goto(`/rooms/${roomId}`);
      await expect(playerPane(clientPage, "Player 2 (you)")).toBeVisible();
      await expect(playerPane(hostPage, "Player 2")).toBeVisible();
    });

    await test.step("set both assigned players to human", async () => {
      await setPlayerMode(hostPage, "Player 1 (you)", "Human");
      await setPlayerMode(clientPage, "Player 2 (you)", "Human");

      await expectPlayerMode(hostPage, "Player 1 (you)", "Human");
      await expectPlayerMode(hostPage, "Player 2", "Human");
      await expectPlayerMode(clientPage, "Player 1", "Human");
      await expectPlayerMode(clientPage, "Player 2 (you)", "Human");
    });

    await test.step("mark both players ready", async () => {
      await setReady(hostPage, "Player 1 (you)");
      await setReady(clientPage, "Player 2 (you)");

      await expectReady(hostPage, "Player 1 (you)");
      await expectReady(hostPage, "Player 2");
      await expectReady(clientPage, "Player 1");
      await expectReady(clientPage, "Player 2 (you)");
    });

    const hostPlayerFrame = playerFrame(hostPage, "Player 1 (you)");
    const clientLeftSpectatorFrame = playerFrame(clientPage, "Player 1");
    const clientPlayerFrame = playerFrame(clientPage, "Player 2 (you)");
    const hostRightSpectatorFrame = playerFrame(hostPage, "Player 2");

    await test.step("wait for both game panes to be playable", async () => {
      await waitForGameReady(hostPlayerFrame);
      await waitForGameReady(clientPlayerFrame);
      await expectClipCount(hostPlayerFrame, 0);
      await expectClipCount(clientLeftSpectatorFrame, 0);
      await expectClipCount(clientPlayerFrame, 0);
      await expectClipCount(hostRightSpectatorFrame, 0);
    });

    await test.step("host makes a paperclip and client spectator catches up on foreground", async () => {
      await clickMakePaperclip(hostPlayerFrame);
      await expectClipCount(hostPlayerFrame, 1);

      await clientPage.bringToFront();
      await expectClipCount(clientLeftSpectatorFrame, 1);
    });

    await test.step("client makes a paperclip and host spectator catches up on foreground", async () => {
      await clickMakePaperclip(clientPlayerFrame);
      await expectClipCount(clientPlayerFrame, 1);

      await hostPage.bringToFront();
      await expectClipCount(hostRightSpectatorFrame, 1);
    });
  } finally {
    await clientContext.close();
    await hostContext.close();
  }
});

async function newSession(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ baseURL: APP_URL });
}

function currentRoomId(page: Page) {
  const id = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
  if (!id) throw new Error(`Could not read room id from ${page.url()}.`);
  return id;
}

function playerPane(page: Page, title: string) {
  return page.getByRole("article", { name: title });
}

async function setPlayerMode(page: Page, playerTitle: string, mode: "Human") {
  const pane = playerPane(page, playerTitle);
  await pane.getByRole("button", { name: mode }).click();
  await expectPlayerMode(page, playerTitle, mode);
}

async function expectPlayerMode(page: Page, playerTitle: string, mode: "Human") {
  await expect(playerPane(page, playerTitle).locator(".mode-badge")).toHaveText(mode);
}

async function setReady(page: Page, playerTitle: string) {
  const pane = playerPane(page, playerTitle);
  const readyText = (await pane.locator(".ready-badge").innerText()).trim();
  if (readyText === "Ready") return;

  await pane.getByRole("button", { name: /^Ready\?$/ }).click();
  await expectReady(page, playerTitle);
}

async function expectReady(page: Page, playerTitle: string) {
  await expect(playerPane(page, playerTitle).locator(".ready-badge")).toHaveText("Ready");
}

function playerFrame(page: Page, playerTitle: string) {
  return page.frameLocator(`iframe[title="${playerTitle} Universal Paperclips"]`);
}

async function waitForGameReady(frame: FrameLocator) {
  await expect(frame.locator("#clips")).toBeVisible({ timeout: 30_000 });
  await expect(frame.getByRole("button", { name: /make paperclip/i })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => frame.locator("html").getAttribute("data-paperclip-battler-input-locked")).toBe("false");
}

async function clickMakePaperclip(frame: FrameLocator) {
  await waitForGameReady(frame);
  await frame.getByRole("button", { name: /make paperclip/i }).click();
}

async function expectClipCount(frame: FrameLocator, expected: number) {
  await expect.poll(() => readClipCount(frame), { timeout: 20_000 }).toBe(expected);
}

async function readClipCount(frame: FrameLocator) {
  const text = await frame.locator("#clips").textContent({ timeout: 1_000 });
  const value = text?.replace(/,/g, "").match(/\d+/)?.[0];
  return value ? Number(value) : 0;
}
