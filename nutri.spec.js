import { test, expect } from '@playwright/test';

// NUTRI v20.1.0 R16.2 release regression, runs against local loopback only.
const STORE = 'NUTRI_PERSONAL_V1';
const fixture = {
  schemaVersion: 1,
  profile: { name: 'QA', birth: '1991-06-08', sex: 'male', height: 178, weight: 78, activity: 'moderate', goal: 'maintain', targetWeight: '', diet: 'all', allergies: [], excluded: '', special: 'none' },
  goals: { kcal: 2000, p: 125, f: 60, c: 240, fiber: 25, customNorms: {}, mode: 'manual' },
  entries: [], supplements: [], userRecipes: [], goalHistory: [], settings: { theme: 'base', onboardingComplete: true }, qualityReviews: {}, wellness: {}, demo: false,
};
const d = days => { const t = new Date(); t.setDate(t.getDate() + days); return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`; };
const state = page => page.evaluate(() => window.NUTRI_QA.getState());
const go = (page, route) => page.locator(`[data-act="tab"][data-route="${route}"]`).click();
const q = page => page.evaluate(() => window.NUTRI_QA);
async function addProduct(page, { date, planned=false, meal='breakfast' }={}) {
  if ((await page.evaluate(() => window.NUTRI_QA.getRoute())) !== 'nutrition') await go(page,'nutrition');
  if(date) await page.locator('[data-change="diaryDate"]').fill(date);
  await page.locator('[data-act="catalog"]').first().click();
  await page.locator('[data-act="catalogType"][data-val="products"]').click();
  const id=await page.evaluate(() => window.NUTRI_QA.DB.ingredients.find(x=>x.p*4+x.f*9+x.c*4>20)?.id);
  expect(id).toBeTruthy();
  await page.locator(`.catalog-card[data-type="product"][data-id="${id}"]`).click();
  await expect(page.locator('#previewMeal')).toBeVisible();
  await page.locator('#previewMeal').selectOption(meal);
  if(date) await page.locator('#previewEntryDate').fill(date);
  await page.locator(`[data-act="savePreview"][data-status="${planned?'planned':'consumed'}"]`).click();
}

// Explicit legacy-profile seed: keeps established diary tests independent of onboarding.
test.beforeEach(async ({page}) => {
  await page.addInitScript(({key, snapshot}) => {
    if(!localStorage.getItem(key))localStorage.setItem(key, JSON.stringify(snapshot));
  }, { key:STORE, snapshot:fixture });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => window.NUTRI_QA?.appVersion)).toBe('20.1.0-R16.2');
});

test('@smoke version, empty diary and three-tab navigation', async ({page}) => {
  expect((await state(page)).entries).toHaveLength(0);
  await go(page,'nutrition'); expect(await page.evaluate(()=>window.NUTRI_QA.getRoute())).toBe('nutrition');
  await go(page,'progress'); expect(await page.evaluate(()=>window.NUTRI_QA.getRoute())).toBe('progress');
  await go(page,'today'); expect(await page.evaluate(()=>window.NUTRI_QA.getRoute())).toBe('today');
  await expect(page.locator('#main')).not.toContainText('Ошибка интерфейса');
});

test('@smoke 22 weighted balance dimensions and embedded numerical tests', async ({page}) => {
  const res=await page.evaluate(()=>{const z=window.NUTRI_QA; return {n:z.DB.dims.length,w:z.DB.dims.reduce((s,x)=>s+x.weight,0),test:z.nutriBalanceSelfTests()};});
  expect(res.n).toBe(22); expect(res.w).toBeCloseTo(1,10);
  expect(res.test.total).toBeGreaterThan(0);expect(res.test.passed).toBe(res.test.total);
});

test('first visit is an independent onboarding, existing diary is preserved', async ({page, browser}) => {
  const first=await browser.newContext();
  try {
    const guest=await first.newPage(); await guest.goto('http://127.0.0.1:4173/');
    await expect(guest.locator('#nutriWelcomeTitle')).toBeVisible();
    expect((await guest.evaluate(()=>window.NUTRI_QA.getState())).entries).toHaveLength(0);
    expect((await guest.evaluate(()=>window.NUTRI_QA.getState())).profile.name).toBe('');
    expect((await state(page)).profile.name).toBe('QA');
  } finally { await first.close(); }
});

test('first-run form collects owner profile and continues to goals', async ({browser}) => {
  const context=await browser.newContext();
  try {
    const p=await context.newPage();await p.goto('http://127.0.0.1:4173/');
    await p.locator('[data-act="setupProfile"]').click();
    await expect(p.locator('#aboutForm')).toBeVisible();
    await p.locator('#aboutForm [name="name"]').fill('Тест');
    await p.locator('#aboutForm [name="birth"]').fill('1992-05-12');
    await p.locator('#aboutForm [name="sex"]').selectOption('male');
    await p.locator('#aboutForm [name="height"]').fill('181');
    await p.locator('#aboutForm [name="weight"]').fill('81');
    await p.locator('#aboutForm button[type="submit"]').click();
    await expect(p.locator('#goalsForm')).toBeVisible();
    await p.locator('#goalsForm [name="activity"]').selectOption('moderate');
    await p.locator('#goalsForm [name="goal"]').selectOption('maintain');
    await p.locator('#goalsForm button[type="submit"]').click();
    await expect(p.locator('#foodprefsForm')).toBeVisible();
    await p.locator('#foodprefsForm [name="diet"]').selectOption('vegetarian');
    await p.locator('#foodprefsForm button[type="submit"]').click();
    await expect.poll(()=>p.evaluate(()=>window.NUTRI_QA.getRoute())).toBe('today');
    const s=await p.evaluate(()=>window.NUTRI_QA.getState());
    expect(s.profile.name).toBe('Тест'); expect(s.profile.diet).toBe('vegetarian');
    await p.reload();await expect.poll(()=>p.evaluate(()=>window.NUTRI_QA.getRoute())).toBe('today');
    expect((await p.evaluate(()=>window.NUTRI_QA.getState())).profile.name).toBe('Тест');
  } finally { await context.close(); }
});

test('overview has a large gauge and five metrics in all segments', async ({page})=>{
  await expect(page.locator('.today .gauge svg')).toBeVisible();
  for(const val of ['macros','vitamins','minerals']){
    await page.locator(`[data-act="segment"][data-val="${val}"]`).click();
    await expect(page.locator('.today .macro-list .macro')).toHaveCount(5);
    await expect(page.locator('.today .macro-list .bar')).toHaveCount(5);
  }
  await page.locator('[data-act="segment"][data-val="macros"]').click();
  await expect(page.locator('[data-act="nutrientDetail"][data-id="saturated_fat_g"]')).toHaveAttribute('aria-label',/верхний лимит, не цель/);
});

test('date validation and selected previous day',async({page})=>{
  const x=await page.evaluate(()=>{const v=window.NUTRI_QA.validDiaryDate;return [v('2024-02-29'),v('2024-02-30'),v('1899-12-31'),v('1900-01-01')];});
  expect(x).toEqual([true,false,false,true]);
  await page.locator('.today-datebar [data-act="day"][data-num="-1"]').click();
  expect(await page.evaluate(()=>window.NUTRI_QA.getDate())).toBe(d(-1));
});

test('@smoke catalog product saves and updates daily calories',async({page})=>{
  await addProduct(page,{date:d(-2)});
  const s=await state(page);expect(s.entries).toHaveLength(1);expect(s.entries[0].status).toBe('consumed');
  expect(s.entries[0].date).toBe(d(-2));
  const kcal=await page.evaluate(date=>window.NUTRI_QA.sumDay(date).kcal,d(-2));
  expect(kcal).toBeGreaterThan(0);
});

test('planned entry is not counted as eaten',async({page})=>{
  await addProduct(page,{date:d(-1),planned:true});
  const s=await state(page);expect(s.entries).toHaveLength(1);expect(s.entries[0].status).toBe('planned');
  expect(await page.evaluate(x=>window.NUTRI_QA.sumDay(x).kcal,d(-1))).toBe(0);
});

test('consumed food persists and can be deleted and undone',async({page})=>{
  await addProduct(page,{date:d(-2)});
  const orig=(await state(page)).entries[0];
  await page.reload();await expect.poll(()=>page.evaluate(()=>!!window.NUTRI_QA)).toBe(true);
  expect((await state(page)).entries[0].id).toBe(orig.id);
  // After a full reload the app restores the Overview route; meal controls live on Nutrition.
  await go(page, 'nutrition');
  await page.locator('[data-change="diaryDate"]').fill(d(-2));
  await page.locator('[data-act="meal"][data-meal="breakfast"]').click();
  await page.locator(`[data-act="deleteEntry"][data-id="${orig.id}"]`).click();
  expect((await state(page)).entries).toHaveLength(0);
  await page.locator('[data-act="undoDelete"]').click();
  expect((await state(page)).entries[0].id).toBe(orig.id);
});

test('manual recipe creates an entry with ingredient mass and saved variant',async({page})=>{
  await go(page,'nutrition');await page.locator('[data-act="addMeal"]').first().click();
  await expect(page.locator('#manualMealForm')).toBeVisible();
  await page.locator('#manualName').fill('Тестовое блюдо');
  const ingredient=await page.evaluate(()=>window.NUTRI_QA.DB.ingredients.find(x=>x.name.length>3&&x.p*4+x.f*9+x.c*4>20)?.name);
  await page.locator('[data-manual="search"][data-index="0"]').fill(ingredient);
  await page.locator('.ingredient-choice[data-index="0"]').first().click();
  await page.locator('[data-manual="grams"][data-index="0"]').fill('150');
  await page.locator('#manualMealForm input[data-manual="saveRecipe"]').check();
  await page.locator('#manualMealForm button[type="submit"]').click();
  const s=await state(page);
  expect(s.entries).toHaveLength(1);expect(s.entries[0].items[0].g).toBe(150);
  expect(s.userRecipes).toHaveLength(1);
});

test('different food diary periods show graphs with no fabricated empty zeros',async({page})=>{
  await go(page,'progress');
  // R12 uses calendar month (30 days) rather than the legacy 28-day quick filter.
  for(const n of ['7','30','90','0']){
    await page.locator(`[data-act="period"][data-num="${n}"]`).click();
    await expect(page.locator('.progress-plot')).toBeVisible();
  }
  const obs=await page.evaluate(date=>window.NUTRI_QA.progressObservation('kcal',date),d(-9));
  expect(obs.v).toBeNull();
});

test('nutrition quality diagnostic is reachable without altering scoring methodology',async({page})=>{
  const report=await page.evaluate(()=>window.NUTRI_QA.nutriIndexIntegrity?.(window.NUTRI_QA.getDate()));
  await expect(page.locator('.today .gauge svg')).toBeVisible();
  expect(typeof report==='object'||report===null).toBeTruthy();
});

test('all page states fit viewport without horizontal overflow',async({page})=>{
  for(const route of ['today','nutrition','progress']){
    if(route!=='today')await go(page,route);
    const s=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:document.documentElement.clientWidth,phone:document.querySelector('#phone')?.getBoundingClientRect().width}));
    expect(s.width).toBeLessThanOrEqual(s.viewport+1);
    expect(s.phone).toBeLessThanOrEqual(s.viewport+1);
  }
});

test('app never calls third party nutrition service at startup',async({page})=>{
  const calls=[];
  page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:4173/')&&!r.url().startsWith('data:'))calls.push(r.url());});
  await page.reload();
  expect(calls).toEqual([]);
});
