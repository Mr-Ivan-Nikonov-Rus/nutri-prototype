import { test, expect } from '@playwright/test';

// NUTRI v20.4.0 R16.2 release regression, runs against local loopback only.
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
  // R16.2: selectFood is a nested button; the outer .catalog-card is not the action target.
  // Choose a caloric product from the rendered page instead of assuming any DB id is visible.
  const id=await page.evaluate(() => {
    const foods=new Map(window.NUTRI_QA.DB.ingredients.map(x=>[String(x.id),x]));
    return [...document.querySelectorAll('#catalogResults button[data-act="selectFood"][data-type="product"]')]
      .map(el=>el.dataset.id)
      .find(id=>{const x=foods.get(id);return x&&x.p*4+x.f*9+x.c*4>20;});
  });
  expect(id, 'Catalog should show at least one caloric product').toBeTruthy();
  await page.locator(`#catalogResults button[data-act="selectFood"][data-type="product"][data-id="${id}"]`).click();
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
  await expect.poll(() => page.evaluate(() => window.NUTRI_QA?.appVersion)).toBe('20.4.0-R16.2');
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

test('profile shares only the public NUTRI link', async ({page}) => {
  await page.evaluate(() => {
    window.shareCalls = [];
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async payload => window.shareCalls.push(payload),
    });
  });
  await page.getByRole('button', { name: 'Открыть профиль' }).click();
  await page.getByRole('button', { name: /Поделиться NUTRI/ }).click();
  await expect.poll(() => page.evaluate(() => window.shareCalls)).toEqual([
    { title: 'NUTRI', url: 'https://nutri-prototype.onrender.com/' },
  ]);
});

test('past recommendations lead with a diary observation and link to dish contributions', async ({page}) => {
  const date = d(-2);
  await page.evaluate(({key, date}) => {
    const data = JSON.parse(localStorage.getItem(key));
    data.entries.push({id:'recommendation-fat', date, meal:'lunch', time:'12:00', name:'Блюдо QA',
      kind:'manual', status:'consumed', grams:200, macros:{kcal:900,p:10,f:95,c:2,fiber:0}});
    localStorage.setItem(key, JSON.stringify(data));
  }, {key: STORE, date});
  await page.reload();
  await page.getByRole('textbox', {name:'Выбрать дату обзора'}).fill(date);
  await page.getByRole('button', {name:'Все рекомендации'}).click();
  await expect(page.getByRole('region', {name:'Главное наблюдение'})).toContainText('Жиров больше, чем в плане');
  await expect(page.getByRole('heading', {name:'Следующий приём пищи', exact:true})).toHaveCount(0);
  await page.getByRole('button', {name:'Вклад блюд · Жиры', exact:true}).click();
  await expect(page.getByText('Блюдо QA', {exact:true}).first()).toBeVisible();
});

test('nutrient detail distinguishes missing, partial and complete sodium totals', async ({page}) => {
  const result = await page.evaluate(() => {
    const info = {kind:'limit', value:2000};
    return [[null,true],[0,false],[900,true],[2000,false],[2200,true],[2200,false]].map(([value,partial]) =>
      nutrientDecision('sodium_mg', '2026-11-20', {value, partial, total:2}, {entries:[{name:'Суп',value}],total:value}, info));
  });
  expect(result[0].headline).toContain('нужны данные');
  expect(result[1].headline).toContain('ниже верхнего лимита');
  expect(result[2].headline).toContain('Итог относительно лимита неизвестен');
  expect(result[3].headline).toContain('на уровне верхнего лимита');
  expect(result[4].headline).toContain('минимум');
  expect(result[5].recommendation).toContain('натрия');
});

test('contribution evidence shows recorded portion, scaled value, source and missing records', async ({page}) => {
  const date = d(-2);
  await page.evaluate(({key,date}) => {
    const data=JSON.parse(localStorage.getItem(key));
    data.entries.push(
      {id:'known-source',date,meal:'lunch',time:'12:00',kind:'manual',name:'Суп QA',status:'consumed',grams:150,source:'Этикетка QA',macros:{kcal:100,p:10,f:2,c:4,fiber:0},nutrients:{sodium_mg:2200}},
      {id:'missing-source',date,meal:'lunch',time:'12:30',kind:'manual',name:'Хлеб QA',status:'consumed',grams:50,macros:{kcal:100,p:3,f:0,c:20,fiber:0}}
    );
    localStorage.setItem(key,JSON.stringify(data));
  }, {key:STORE,date});
  await page.reload();
  await page.getByRole('textbox',{name:'Выбрать дату обзора'}).fill(date);
  await page.getByRole('button',{name:'Все рекомендации'}).click();
  await page.getByRole('button',{name:'Вклад блюд · Натрий'}).click();
  const evidence=page.getByRole('region',{name:'Откуда эта цифра'});
  await expect(evidence).toContainText('1 из 2 записей');
  await expect(evidence).toContainText('Хлеб QA · нет данных');
  await evidence.getByText(/Суп QA ·/).click();
  await expect(evidence.getByText(/150 г.*на 100 г/)).toBeVisible();
  await expect(evidence.getByText('Источник в записи: Этикетка QA')).toBeVisible();
});

test('all catalog recipes support an explicit output without changing the catalog', async ({page}) => {
  const check=await page.evaluate(() => {
    const recipes=window.NUTRI_QA.DB.recipes;
    previewMode='recipe';
    return recipes.map(r=>{
      previewRef=r.id;
      previewGrams=Math.min(100,r.yieldG);
      const before=previewValues({yieldOverride:null,entry:null});
      const after=previewValues({yieldOverride:r.yieldG*2,entry:null});
      return {id:r.id,before:before?.macros.kcal,after:after?.macros.kcal,basis:after?.yieldBasis};
    });
  });
  expect(check.length).toBeGreaterThanOrEqual(120);
  for(const row of check){
    expect(row.basis,row.id).toBe('user');
    expect(row.after,row.id).toBeCloseTo(row.before/2,8);
  }
});

test('recipe preview stores the user yield and preserves the original catalog', async ({page}) => {
  await go(page,'nutrition');
  await page.locator('[data-act="catalog"]').first().click();
  const recipe=page.locator('#catalogResults button[data-act="selectFood"][data-type="recipe"]').first();
  const id=await recipe.getAttribute('data-id');
  const original=await page.evaluate(id=>window.NUTRI_QA.DB.recipes.find(r=>r.id===id).yieldG,id);
  await recipe.click();
  await page.getByText(/Вес готового блюда ·/).click();
  await page.getByLabel('Вес всей готовой партии, г').fill(String(original*2));
  await page.getByRole('button',{name:'Применить вес'}).click();
  await expect(page.getByText('Вес готового блюда указан вами')).toBeVisible();
  await page.locator('[data-act="savePreview"][data-status="consumed"]').click();
  const entry=(await state(page)).entries[0];
  expect(entry.recipeYieldG).toBe(original*2);
  expect(entry.recipeYieldBasis).toBe('user');
  expect(await page.evaluate(id=>window.NUTRI_QA.DB.recipes.find(r=>r.id===id).yieldG,id)).toBe(original);
});

test('own label product is searchable, reusable and historical entries survive edits', async ({page}) => {
  await go(page,'nutrition');
  await page.locator('[data-act="catalog"]').first().click();
  await page.getByRole('button',{name:'Продукты',exact:true}).click();
  await page.getByRole('button',{name:'Добавить свой продукт'}).click();
  const form=page.locator('#ownProductForm');
  for(const [name,value] of Object.entries({name:'Йогурт QA',kcal:'100',p:'8',f:'3',c:'10'})){
    await form.locator(`[name="${name}"]`).fill(value);
  }
  await form.getByText('Дополнительно с этикетки').click();
  await form.locator('[name="sodium_mg"]').fill('80');
  await form.locator('[name="added_sugar_g"]').fill('0');
  await form.getByRole('button',{name:'Сохранить продукт'}).click();
  await page.locator('#catalogSearch').fill('Йогурт QA');
  await page.getByRole('button',{name:'Открыть Йогурт QA'}).click();
  await expect(page.getByText('Введено с этикетки',{exact:true})).toBeVisible();
  await page.locator('#portion').fill('150');
  await page.locator('#portion').press('Tab');
  await page.locator('[data-act="savePreview"][data-status="consumed"]').click();
  await page.reload();
  const first=(await state(page)).entries[0];
  expect(first.macros).toEqual({kcal:150,p:12,f:4.5,c:15,fiber:null});
  expect(first.nutrients).toEqual({sodium_mg:120,added_sugar_g:0});
  await go(page,'nutrition');
  await page.locator('[data-act="catalog"]').first().click();
  await page.getByRole('button',{name:'Продукты',exact:true}).click();
  await page.getByRole('button',{name:'Открыть Йогурт QA'}).click();
  await page.getByRole('button',{name:'Изменить свой продукт'}).click();
  await page.locator('#ownProductForm [name="kcal"]').fill('130');
  await page.getByRole('button',{name:'Сохранить продукт'}).click();
  await page.locator('[data-act="savePreview"][data-status="consumed"]').click();
  const updated=(await state(page)).entries;
  expect(updated.map(row=>row.macros.kcal)).toEqual([150,130]);
});

test('built-in catalog records have unique IDs, valid macro values and traceable inputs', async ({page}) => {
  const audit=await page.evaluate(() => {
    const {ingredients,recipes}=window.NUTRI_QA.DB;
    const unique=list=>new Set(list.map(row=>row.id)).size===list.length;
    const macros=row=>['kcal','p','f','c'].every(key=>Number.isFinite(row[key])&&row[key]>=0);
    return {
      unique:unique(ingredients)&&unique(recipes),
      products:ingredients.filter(row=>!macros(row)||!row.source).map(row=>row.id),
      recipes:recipes.filter(row=>!macros(row.macros)||!(row.yieldG>0)||
        !row.items.length||row.items.some(it=>!(it.g>0)||!ingredients.some(product=>product.id===it.ingredientId))).map(row=>row.id)
    };
  });
  expect(audit.unique).toBe(true);
  expect(audit.products).toEqual([]);
  expect(audit.recipes).toEqual([]);
});

test('diary shows aligned micronutrients and a green add-food action', async ({page}, testInfo) => {
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(key=>{
    const data=JSON.parse(localStorage.getItem(key));
    data.goals.customNorms.vitamin_d_mcg=15;
    data.entries.push({id:'micros-layout',date:todayISO(),meal:'lunch',time:'12:00',kind:'manual',
      name:'Тёплый салат',status:'consumed',grams:240,
      macros:{kcal:443,p:16,f:17,c:55,fiber:8},
      nutrients:{vitamin_d_mcg:7,vitamin_c_mg:78,vitamin_b12_mcg:2,magnesium_mg:298,iron_mg:7.6,calcium_mg:850}});
    localStorage.setItem(key,JSON.stringify(data));
  },STORE);
  await page.reload();
  await page.locator('.today-day-arrow[data-num="-1"]').click();
  await expect(page.locator('.today .retro-context-note')).toHaveCount(0);
  await page.locator('.today-day-arrow[data-num="1"]').click();
  await page.setViewportSize({width:390,height:844});
  await expect(page.locator('.today .macro[data-id="protein_g"] .bar')).toHaveCSS('height','8px');
  await expect(page.locator('.today .macro[data-id="protein_g"] .bar i')).toHaveCSS('background-image',/rgb\(161, 122, 235\)/);
  const proteinFill=page.locator('.today .macro[data-id="protein_g"] .bar i');
  await expect.poll(async ()=> (await proteinFill.boundingBox())?.width??0).toBeGreaterThan(20);
  await testInfo.attach('overview-390',{body:await page.locator('.today .macro-list').screenshot(),contentType:'image/png'});
  await go(page,'nutrition');
  const row=page.locator('.micro-diary-row[data-nutrient="vitamin_d_mcg"]');
  await expect(row.locator('.micro-amount')).toContainText(/7\s*\/15/);
  await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow','47');
  const section=row.locator('..');
  await expect(section.locator('[data-nutrient="vitamin_b12_mcg"] .micro-name')).toHaveText('B12');
  for(const width of [320,390]){
    await page.setViewportSize({width,height:844});
    for(const item of await section.locator('.micro-diary-row').all()){
      const cells=await item.locator(':scope > *').all();
      expect(cells).toHaveLength(3);
      const [label,bar,amount]=await Promise.all(cells.map(cell=>cell.boundingBox()));
      expect(label.x+label.width).toBeLessThanOrEqual(bar.x);
      expect(bar.x+bar.width).toBeLessThanOrEqual(amount.x);
      expect(amount.x+amount.width).toBeLessThanOrEqual(width);
    }
    if(width===390)await testInfo.attach('micronutrients-390',{body:await section.screenshot(),contentType:'image/png'});
  }
  await expect(row.locator('.bar')).toHaveCSS('height','9px');
  await page.getByRole('button',{name:'Все нутриенты'}).click();
  await expect(page.locator('.norm-row.nutrient-strip')).toHaveCount(22);
  const sugar=page.getByRole('button',{name:'Открыть норму Добавленный сахар'});
  await expect(sugar.locator('strong')).toHaveText('Сахар');
  const saturatedFat=page.getByRole('button',{name:'Открыть норму Насыщенные жиры'});
  await expect(saturatedFat.locator('strong')).toHaveText('НЖК');
  for (const width of [320,390]) {
    await page.setViewportSize({width,height:844});
    expect(await saturatedFat.locator('strong').evaluate(label=>label.scrollWidth<=label.clientWidth)).toBe(true);
  }
  await testInfo.attach('limits-390',{body:await saturatedFat.locator('xpath=..').screenshot(),contentType:'image/png'});
  const fullRow=page.locator('.norm-row[data-id="vitamin_d_mcg"]');
  await expect(fullRow.locator('.micro-amount')).toContainText(/7\s*\/15/);
  await expect(fullRow.getByRole('progressbar')).toHaveAttribute('aria-valuenow','47');
  await testInfo.attach('all-nutrients-390',{body:await page.locator('.norm-group[data-norm-group="C"]').screenshot(),contentType:'image/png'});
  await page.getByRole('searchbox').fill('магний');
  await expect(page.locator('.norm-row:visible')).toHaveCount(1);
  await page.getByRole('button',{name:/Открыть норму Магний/i}).click();
  await expect(page.locator('#normForm')).toBeVisible();
  await expect(page.getByRole('heading',{name:'Магний',exact:true})).toBeVisible();
  await page.reload();
  await go(page,'nutrition');
  await page.locator('[data-act="meal"][data-meal="lunch"]').click();
  const add=page.getByRole('button',{name:'Добавить еду'});
  await expect(add).toHaveClass(/\bprimary\b/);
  await expect(add).toHaveCSS('background-image',/rgb\(197, 247, 108\)/);
  await testInfo.attach('meal-add-food-390',{body:await page.screenshot(),contentType:'image/png'});
  await add.click();
  await expect(page.locator('#manualMealForm')).toBeVisible();
});
