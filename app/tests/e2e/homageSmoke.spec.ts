/**
 * /homage section smoke — the UNCONFIGURED state.
 *
 * The e2e fork deploys the PC stack but never sets NEXT_PUBLIC_HOMAGE_ADDRESS,
 * so this suite pins the pre-deploy behavior every visitor sees until the
 * Homage contract ships:
 *
 *   1. /homage gates to the local explore preview (no mint form, no crash) —
 *      rendering is 100% client-local (punks-sdk pixel bundle), zero RPC.
 *   2. /homage/explore id lookup works end-to-end.
 *   3. /homage/redeem shows its honest "no contract" state.
 *   4. /homage/calculator renders with either a live pool price or its seeded
 *      defaults (the fork's PC token pool may or may not resolve — both are
 *      designed states; what must NOT happen is a blank/broken page).
 *   5. The homage styling scope does not leak: PC pages keep their ink.
 *
 * Tests must FAIL LOUD when preconditions are missing (dev server down,
 * route absent). Standing rule [[feedback_test_fail_loud]].
 */

import {e2eTest, expect} from './fixtures/renderer';

e2eTest.describe('Homage section (unconfigured)', () => {
    e2eTest('/homage renders the explore preview behind the gate', async ({page}) => {
        const pageErrors: string[] = [];
        page.on('pageerror', (err) => pageErrors.push(String(err)));

        await page.goto('/homage');

        // PC site chrome wraps the section, with the new nav entry present.
        await expect(
            page.getByRole('navigation', {name: 'Primary navigation'}).getByRole('link', {name: 'Homage'}),
        ).toBeVisible();

        // The explore preview is up: its id input renders and the art frame
        // fills in from the locally-rendered SDK data (art-img appears once
        // the pixel bundle chunk loads — generous timeout for the ~MBs chunk).
        await expect(page.getByLabel('punk id')).toBeVisible();
        await expect(page.locator('.art-img').first()).toBeVisible({timeout: 30_000});

        // Preview mode: ExploreView's own mini-header (the "mint →" link back
        // to /homage) is suppressed — the PC chrome is the only header.
        await expect(page.getByRole('link', {name: 'mint →'})).toHaveCount(0);

        // The homage scope carries its own dark ground.
        const bg = await page
            .locator('.homage-root')
            .evaluate((el) => getComputedStyle(el).backgroundColor);
        expect(bg).toBe('rgb(8, 8, 10)');

        expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toHaveLength(0);
    });

    e2eTest('/homage/explore id lookup drives the view', async ({page}) => {
        await page.goto('/homage/explore');

        // Non-preview explore shows its own mini-header linking back to the mint.
        await expect(page.getByRole('link', {name: 'mint →'})).toBeVisible();

        const idInput = page.getByLabel('punk id');
        await expect(idInput).toBeVisible();
        await idInput.fill('42');
        await idInput.press('Enter');

        // The traits panel resolves the punk id into its cryptopunks.app link
        // once homage #42 finishes rendering locally.
        await expect(
            page.locator('a[href="https://cryptopunks.app/cryptopunks/details/42"]'),
        ).toBeVisible({timeout: 30_000});
    });

    e2eTest('/homage/redeem shows the unconfigured state', async ({page}) => {
        await page.goto('/homage/redeem');
        await expect(page.getByText('No contract deployed yet.')).toBeVisible();
    });

    e2eTest('/homage/calculator renders live-or-seeded pricing', async ({page}) => {
        const pageErrors: string[] = [];
        page.on('pageerror', (err) => pageErrors.push(String(err)));

        await page.goto('/homage/calculator');
        await expect(page.getByRole('heading', {name: 'Mint-price calculator'})).toBeVisible();

        // Either designed pricing state is acceptable; a blank page is not.
        await expect(page.getByText(/live price unavailable — using seeded defaults|projected totals/i).first())
            .toBeVisible({timeout: 15_000});

        expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toHaveLength(0);
    });

    e2eTest('homage styling stays scoped — PC pages keep their ink', async ({page}) => {
        // Visit a homage page first so its stylesheet is definitely loaded
        // into the client-side navigation session, then check PC's home.
        await page.goto('/homage');
        await expect(page.getByLabel('punk id')).toBeVisible();
        await page.goto('/');

        const bodyColor = await page.evaluate(() => getComputedStyle(document.body).color);
        expect(bodyColor).toBe('rgb(17, 17, 17)'); // PC --ink, not homage's #e7e7ea

        const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        expect(bodyBg).toBe('rgb(255, 255, 255)'); // PC --bg, not homage's dark paper
    });

    e2eTest('the header renders outside the homage scope with PC fonts', async ({page}) => {
        // Regression guard: the header/footer must sit OUTSIDE .homage-root, or
        // they inherit homage's font-family and the scoped input/button font
        // rule (the connect button + live-bid chip render in homage's mono/sans
        // instead of PC's IBM Plex).
        await page.goto('/homage');
        const bid = page.locator('header .header-bid').first();
        await expect(bid).toBeVisible();
        const inScope = await bid.evaluate((el) => !!el.closest('.homage-root'));
        expect(inScope).toBe(false);
        const bidFont = await bid.evaluate((el) => getComputedStyle(el).fontFamily);
        expect(bidFont).toContain('IBM Plex'); // PC's font, not homage's ui-sans-serif stack
    });

    e2eTest('the id input renders as a clean underline, not a native box', async ({page}) => {
        // Regression guard for the scoped preflight border reset: without it,
        // the number input's native ~2px inset border shows on all four sides,
        // competing with the intended 1px atelier underline.
        await page.goto('/homage/explore');
        const input = page.getByLabel('punk id');
        await expect(input).toBeVisible();
        const borders = await input.evaluate((el) => {
            const s = getComputedStyle(el);
            return {top: s.borderTopWidth, left: s.borderLeftWidth, right: s.borderRightWidth, bottom: s.borderBottomWidth};
        });
        expect(borders.top).toBe('0px');
        expect(borders.left).toBe('0px');
        expect(borders.right).toBe('0px');
        expect(borders.bottom).toBe('1px'); // the atelier underline survives
    });
});
