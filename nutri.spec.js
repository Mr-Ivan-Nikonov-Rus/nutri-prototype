import { test, expect } from '@playwright/test';

// Runs against localhost only: never writes into the production user's browser.
const STORE = 'NUTRI_PERSONAL_V1';
const qa = async (page, code, arg) => page.evaluate(([expression, value]) => {
  // Functions below are called explicitly inside the page; no eval is needed.
  const Q = window.NUTRI_QA;
  if (expression === 'state') return Q.getState();
  if (expression === 'date') return Q.getDate();
  if (expression === 'route') return Q.getRoute();
  if (expression === 'sum') return Q.sumDay(value);
  if (expression === 'ref') return Q.goalsForDate(value);
  if (expression === 'observation') return Q.progressObservation(value.metric, value.date);
  throw Error('Unknown expression: ' + expression);
}, [code, arg]);
const tab = (page, name) => page.locator(`[data-act="tab"][data-route="${name}"]`).click();
const addDays = (iso, days) => {
  const x = new Date(`${iso}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + days);
  return x.toISOString().slice(0, 10);
};
const today = (page) => page.evaluate(() => {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
});

async function addCatalogProduct(page, { date, planned = false, meal = 'breakfast' } = {}) {
  if (await qa(page, 'route') !== 'nutrition') await tab(page, 'nutrition');
  if (date) await page.locator('[data-change="diaryDate"]').fill(date);
  await page.locator('[data-act="catalog"]').first().click();
  await page.locator('[data-act="catalogType"][data-val="products"]').click();
  const id = await page.evaluate(() => window.NUTRI_QA.DB.ingredients.slice(0, 100).find(x => 4*x.p + 9*x.f + 4*x.c > 20)?.id);
  if (!id) throw Error('No positive-calorie product in visible catalog');
  const product = page.locator(`.catalog-card[data-type="product"][data-id="${id}"]`);
  await expect(product).toBeVisible();
  await product.click();
  await expect(page.locator('#previewMeal')).toBeVisible();
  await page.locator('#previewMeal').selectOption(meal);
  if (date) await page.locator('#previewEntryDate').fill(date);
  await page.locator(`[data-act="savePreview"][data-status="${planned ? 'planned' : 'consumed'}"]`).click();
}

async function createManualMeal(page, { date, name = 'QA-приём пищи', saveRecipe = false } = {}) {
  if (await qa(page, 'route') !== 'nutrition') await tab(page, 'nutrition');
  await page.locator('[data-act="addMeal"]').first().click();
  await expect(page.locator('#manualMealForm')).toBeVisible();
  if (date) await page.locator('#manualEntryDate').fill(date);
  await page.locator('#manualName').fill(name);
  const ingredient = await page.evaluate(() => window.NUTRI_QA.DB.ingredients.find(x => x.name.length > 3 && (4*x.p+9*x.f+4*x.c)>20)?.name);
  if (!ingredient) throw Error('Catalog lacks ingredients');
  await page.locator('[data-manual="search"][data-index="0"]').fill(ingredient);
  const suggestion = page.locator('.ingredient-choice[data-index="0"]').first();
  await expect(suggestion).toBeVisible();
  await suggestion.click();
  await page.locator('[data-manual="grams"][data-index="0"]').fill('150');
  if (saveRecipe) await page.locator('#manualMealForm input[data-manual="saveRecipe"]').check();
  await page.locator('#manualMealForm button[type="submit"]').click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean(window.NUTRI_QA))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.NUTRI_QA.appVersion)).toBe('19.4.0');
});

test('@smoke fresh launch: clean diary, correct version, working navigation', async ({ page }) => {
  const state = await qa(page, 'state');
  expect(state.entries).toEqual([]);
  expect(state.supplements).toEqual([]);
  await expect(page.locator('#main')).not.toContainText('Ошибка интерфейса');
  await tab(page, 'nutrition');
  expect(await qa(page, 'route')).toBe('nutrition');
  await tab(page, 'progress');
  expect(await qa(page, 'route')).toBe('progress');
  await tab(page, 'today');
  expect(await qa(page, 'route')).toBe('today');
});

test('@smoke 22 nutrient model and embedded numerical self-tests', async ({ page }) => {
  const actual = await page.evaluate(() => {
    const q = window.NUTRI_QA;
    const suite = q.nutriBalanceSelfTests();
    return { dimensions: q.DB.dims.length, totalWeight: q.DB.dims.reduce((s, d) => s + d.weight, 0), suite };
  });
  expect(actual.dimensions).toBe(22);
  expect(actual.totalWeight).toBeCloseTo(1, 10);
  expect(actual.suite.passed).toBe(actual.suite.total);
  expect(actual.suite.total).toBeGreaterThan(0);
});

test('@smoke date validation: calendar bounds, invalid days, future prohibition', async ({ page }) => {
  const d = await today(page);
  const result = await page.evaluate(future => {
    const v = window.NUTRI_QA.validDiaryDate;
    return { leap: v('2024-02-29'), invalid: v('2024-02-30'), ancient: v('1899-12-31'), valid: v('1900-01-01'), future: v(future), futurePlanned: v(future, { allowFuture: true }) };
  }, addDays(d, 1));
  expect(result).toEqual({ leap: true, invalid: false, ancient: false, valid: true, future: false, futurePlanned: true });
});

test('@smoke overview can navigate backwards, not forward beyond today', async ({ page }) => {
  const d = await today(page);
  await page.locator('.today-datebar [data-act="day"][data-num="-1"]').click();
  expect(await qa(page, 'date')).toBe(addDays(d, -1));
  await page.locator('.today-datebar [data-act="day"][data-num="1"]').click();
  expect(await qa(page, 'date')).toBe(d);
  await expect(page.locator('.today-datebar [data-act="day"][data-num="1"]')).toBeDisabled();
});

test('@smoke product selected from catalog saves consumed entry and updates calories', async ({ page }) => {
  const d = addDays(await today(page), -2);
  await addCatalogProduct(page, { date: d });
  const state = await qa(page, 'state');
  expect(state.entries).toHaveLength(1);
  expect(state.entries[0].date).toBe(d);
  expect(state.entries[0].status).toBe('consumed');
  expect(state.entries[0].meal).toBe('breakfast');
  expect((await qa(page, 'sum', d)).kcal).toBeGreaterThan(0);
});

test('@smoke future consumed record is rejected, future planned is allowed', async ({ page }) => {
  const date = addDays(await today(page), 2);
  await tab(page, 'nutrition');
  await page.locator('[data-act="catalog"]').first().click();
  await page.locator('[data-act="catalogType"][data-val="products"]').click();
  await page.locator('.catalog-card[data-type="product"]').first().click();
  await page.locator('#previewEntryDate').fill(date);
  await page.locator('[data-act="savePreview"][data-status="consumed"]').click();
  expect((await qa(page, 'state')).entries).toHaveLength(0);
  await expect(page.locator('#toast')).toContainText('будущую дату');
  await page.locator('[data-act="savePreview"][data-status="planned"]').click();
  const state = await qa(page, 'state');
  expect(state.entries).toHaveLength(1);
  expect(state.entries[0].date).toBe(date);
  expect(state.entries[0].status).toBe('planned');
  expect((await qa(page, 'sum', date)).kcal).toBe(0);
});

test('selected retrospective day survives navigation to overview, diary and progress', async ({ page }) => {
  const d = addDays(await today(page), -18);
  await page.locator('[data-change="overviewDate"]').fill(d);
  expect(await qa(page, 'date')).toBe(d);
  await tab(page, 'nutrition');
  expect(await qa(page, 'date')).toBe(d);
  await expect(page.locator('[data-change="diaryDate"]')).toHaveValue(d);
  await tab(page, 'progress');
  await expect(page.locator('[data-change="progressEndDate"]')).toHaveValue(d);
});

test('retrospective entry persists after reload and is observable in progress', async ({ page }) => {
  const d = addDays(await today(page), -4);
  await addCatalogProduct(page, { date: d });
  const kcal = (await qa(page, 'sum', d)).kcal;
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!window.NUTRI_QA)).toBe(true);
  expect((await qa(page, 'state')).entries).toHaveLength(1);
  expect((await qa(page, 'sum', d)).kcal).toBeCloseTo(kcal, 5);
  const observation = await qa(page, 'observation', { metric: 'kcal', date: d });
  expect(observation.v).toBeCloseTo(kcal, 5);
  await tab(page, 'progress');
  await page.locator('[data-change="progressEndDate"]').fill(d);
  await expect(page.locator('#main')).not.toContainText('Ошибка интерфейса');
});

test('planned food is excluded from daily actuals and progress', async ({ page }) => {
  const d = addDays(await today(page), -1);
  await addCatalogProduct(page, { date: d, planned: true });
  expect((await qa(page, 'state')).entries[0].status).toBe('planned');
  expect((await qa(page, 'sum', d)).kcal).toBe(0);
  const obs = await qa(page, 'observation', { metric: 'kcal', date: d });
  expect(obs.v).toBeNull();
});

test('meal delete supports undo without data loss', async ({ page }) => {
  const d = addDays(await today(page), -2);
  await addCatalogProduct(page, { date: d });
  const initial = (await qa(page, 'state')).entries[0];
  await page.locator('[data-act="meal"][data-meal="breakfast"]').click();
  await page.locator(`[data-act="deleteEntry"][data-id="${initial.id}"]`).click();
  expect((await qa(page, 'state')).entries).toHaveLength(0);
  await page.locator('[data-act="undoDelete"]').click();
  expect((await qa(page, 'state')).entries).toHaveLength(1);
  expect((await qa(page, 'state')).entries[0].id).toBe(initial.id);
});

test('manual meal uses catalog ingredient mass, is editable and can become personal recipe', async ({ page }) => {
  const d = addDays(await today(page), -3);
  await createManualMeal(page, { date: d, saveRecipe: true });
  let state = await qa(page, 'state');
  expect(state.entries).toHaveLength(1);
  expect(state.entries[0].date).toBe(d);
  expect(state.entries[0].kind).toBe('manual');
  expect(state.entries[0].items[0].g).toBe(150);
  expect(state.userRecipes).toHaveLength(1);
  const id = state.entries[0].id;
  await page.locator('[data-act="meal"][data-meal="lunch"]').click();
  await page.locator(`[data-act="editEntry"][data-id="${id}"]`).click();
  await page.locator('[data-manual="grams"][data-index="0"]').fill('180');
  await page.locator('#manualMealForm button[type="submit"]').click();
  state = await qa(page, 'state');
  expect(state.entries).toHaveLength(1);
  expect(state.entries[0].items[0].g).toBe(180);
});

test('historical goal timeline switches between current and saved goals', async ({ page }) => {
  const d = '2026-02-01';
  await page.evaluate(store => {
    const state = window.NUTRI_QA.getState();
    const oldPlan = structuredClone(state.goals);
    oldPlan.kcal = 1700;
    state.goalHistory = [{ date: '2026-01-01', at: '2026-01-01T09:00:00.000Z', next: oldPlan, previous: oldPlan, reason: 'QA fixture' }];
    localStorage.setItem(store, JSON.stringify(state));
  }, STORE);
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(window.NUTRI_QA))).toBe(true);
  expect((await qa(page, 'ref', d)).kcal).toBe(2000);
  await tab(page, 'progress');
  await page.locator('[data-change="normTimeline"]').selectOption('historical');
  expect((await qa(page, 'ref', d)).kcal).toBe(1700);
  await page.reload();
  expect((await qa(page, 'ref', d)).kcal).toBe(1700);
  await tab(page, 'progress');
  await page.locator('[data-change="normTimeline"]').selectOption('current');
  expect((await qa(page, 'ref', d)).kcal).toBe(2000);
});

test('age reference is based on target date, not only current age', async ({ page }) => {
  const ages = await page.evaluate(() => {
    const f = window.NUTRI_QA.ageFromBirthOnDate;
    return [f('2000-12-15', '2026-12-14'), f('2000-12-15', '2026-12-15'), f('2000-12-15', '2026-12-16')];
  });
  expect(ages).toEqual([25, 26, 26]);
});

test('progress supports 7, 28, 90 days and whole history without treating empty days as zero', async ({ page }) => {
  await tab(page, 'progress');
  for (const period of ['7', '28', '90', '0']) {
    await page.locator(`[data-act="period"][data-num="${period}"]`).click();
    await expect(page.locator('.progress-plot')).toBeVisible();
    await expect(page.locator('#main')).not.toContainText('Ошибка интерфейса');
  }
  const noData = await qa(page, 'observation', { metric: 'kcal', date: addDays(await today(page), -10) });
  expect(noData.v).toBeNull();
});

test('supplement statuses: planned does not silently become taken', async ({ page }) => {
  await tab(page, 'nutrition');
  await page.locator('[data-act="supplementForm"]').first().click();
  await page.locator('#suppForm [name="name"]').fill('QA D3');
  await page.locator('#suppForm [name="amount"]').fill('10');
  await page.locator('#suppForm [name="nutrient"]').selectOption('vitamin_d_mcg');
  await page.locator('#suppForm [name="nutrientAmount"]').fill('10');
  await page.locator('#suppForm [name="status"]').selectOption('planned');
  await page.locator('#suppForm button[type="submit"]').click();
  expect((await qa(page, 'state')).supplements[0].status).toBe('planned');
  await tab(page, 'nutrition');
  await page.locator('[data-act="toggleSupp"]').first().click();
  expect((await qa(page, 'state')).supplements[0].status).toBe('taken');
  expect((await qa(page, 'sum', await today(page))).kcal).toBe(0);
});

test('export JSON contains the full diary and can be parsed', async ({ page }) => {
  const d = addDays(await today(page), -2);
  await addCatalogProduct(page, { date: d });
  await page.locator('[data-act="profile"]').click();
  await page.locator('[data-act="settings"]').click();
  await page.locator('[data-act="privacy"]').click();
  await page.locator('[data-act="export"]').click();
  const raw = await page.locator('#backupTextArea').inputValue();
  const snapshot = JSON.parse(raw);
  expect(snapshot.schemaVersion).toBe(1);
  expect(snapshot.entries).toHaveLength(1);
  expect(snapshot.entries[0].date).toBe(d);
});

test('nutrition sections show five metrics and limit for saturated fats', async ({ page }) => {
  const sectionTexts = await page.evaluate(() => {
    const main = document.querySelector('#main');
    return main?.innerText || '';
  });
  expect(sectionTexts).toContain('Клетчатка');
  const buttons = page.locator('[data-act="segment"]');
  await expect(buttons).toHaveCount(3);
  await page.locator('[data-act="segment"][data-val="vitamins"]').click();
  await expect(page.locator('#main')).toContainText('Витамин D');
  await page.locator('[data-act="segment"][data-val="minerals"]').click();
  await expect(page.locator('#main')).toContainText('Магний');
  await page.locator('[data-act="segment"][data-val="macros"]').click();
  await expect(page.locator('#main')).toContainText('Насыщенные');
});

test('local-first: initial page makes no external nutrition-service requests', async ({ page }) => {
  const calls = [];
  page.on('request', request => {
    if (!request.url().startsWith('http://127.0.0.1:4173/') && !request.url().startsWith('data:')) calls.push(request.url());
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(window.NUTRI_QA))).toBe(true);
  expect(calls).toEqual([]);
});

test('layout fits mobile viewport without horizontal page overflow', async ({ page, isMobile }) => {
  const box = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    width: document.documentElement.scrollWidth,
    phoneWidth: document.getElementById('phone').getBoundingClientRect().width,
  }));
  expect(box.width).toBeLessThanOrEqual(box.viewport + 1);
  expect(box.phoneWidth).toBeLessThanOrEqual(box.viewport + 1);
  if (isMobile) await expect(page.locator('[data-act="tab"]')).toHaveCount(3);
});


test('legacy v1 backup without goalHistory can still save a changed nutrition plan', async ({ page }) => {
  const before = await qa(page, 'state');
  delete before.goalHistory;
  await page.evaluate(([store, snapshot]) => localStorage.setItem(store, JSON.stringify(snapshot)), [STORE, before]);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!window.NUTRI_QA)).toBe(true);
  await page.locator('[data-act="profile"]').click();
  await page.locator('[data-act="plan"]').click();
  await page.locator('#goalForm button[type="submit"]').click();
  const after = await qa(page, 'state');
  expect(Array.isArray(after.goalHistory)).toBe(true);
  expect(after.goalHistory).toHaveLength(1);
});

test('text backup import normalizes missing goalHistory before editing goals', async ({ page }) => {
  const snapshot = await qa(page, 'state');
  delete snapshot.goalHistory;
  await page.locator('[data-act="profile"]').click();
  await page.locator('[data-act="settings"]').click();
  await page.locator('[data-act="privacy"]').click();
  await page.locator('[data-act="importText"]').click();
  await page.locator('#importTextArea').fill(JSON.stringify(snapshot));
  await page.locator('[data-act="stageTextImport"]').click();
  await page.locator('[data-act="confirmImport"]').click();
  expect(Array.isArray((await qa(page, 'state')).goalHistory)).toBe(true);
  await page.locator('[data-act="plan"]').click();
  await page.locator('#goalForm button[type="submit"]').click();
  expect((await qa(page, 'state')).goalHistory).toHaveLength(1);
});


test('v19.4 overview preserves all five scales and the full balance gauge', async ({ page }) => {
  await expect(page.locator('.today .gauge svg')).toBeVisible();
  await expect(page.locator('.today .macro-list .macro')).toHaveCount(5);
  await expect(page.locator('.today .macro-list .bar')).toHaveCount(5);
  await page.locator('[data-act="segment"][data-val="vitamins"]').click();
  await expect(page.locator('.today .macro-list .macro')).toHaveCount(5);
  await expect(page.locator('.today .macro-list .bar')).toHaveCount(5);
  await page.locator('[data-act="segment"][data-val="minerals"]').click();
  await expect(page.locator('.today .macro-list .macro')).toHaveCount(5);
  await expect(page.locator('.today .macro-list .bar')).toHaveCount(5);
  await page.locator('[data-act="segment"][data-val="macros"]').click();
  await expect(page.locator('[data-act="nutrientDetail"][data-id="saturated_fat_g"]')).toHaveAttribute('aria-label', /верхний лимит, не цель/);
});

test('v19.4 product sources and accessible scrubbing update detail correctly', async ({ page }) => {
  await addCatalogProduct(page, { meal: 'breakfast' });
  await addCatalogProduct(page, { meal: 'lunch' });
  await tab(page, 'today');
  await page.locator('[data-act="nutrientDetail"][data-id="protein_g"]').click();
  await expect(page.locator('.contribution-explorer')).toBeVisible();
  await expect(page.locator('.contribution-row')).toHaveCount(2);
  await expect(page.locator('.contribution-slider')).toHaveAttribute('aria-label', /вклад продуктов/);
  const original = await page.locator('.contribution-tooltip').innerText();
  expect(original).toContain('50%');
  await page.locator('.contribution-slider').evaluate(el => { el.value='90'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(page.locator('.contribution-row').nth(1)).toHaveAttribute('aria-pressed','true');
  await page.locator('.contribution-row').first().click();
  await expect(page.locator('.contribution-row').first()).toHaveAttribute('aria-pressed','true');
});
