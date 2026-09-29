// ---------- data ----------
const $=s=>document.querySelector(s), uid=()=>crypto.randomUUID();
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const KEY='nt_db', LOW=2, REQ=['cal','protein','carbs','fat'];
const NUT=[['cal','Calories','kcal'],['protein','Protein','g'],['carbs','Carbs','g'],['fat','Fat','g'],['fiber','Fiber','g'],['zinc_mg','Zinc','mg'],['magnesium_mg','Magnesium','mg']];
let db=JSON.parse(localStorage.getItem(KEY)||'null')||{ingredients:[],packages:[],recipes:[],inventory:{},meals:[],purchases:[],settings:{usda_key:''}};
const save=()=>localStorage.setItem(KEY,JSON.stringify(db));
const ing=id=>db.ingredients.find(i=>i.id===id), rec=id=>db.recipes.find(r=>r.id===id);
const fmt=(x,d=1)=>x==null?'?':(+x).toFixed(d).replace(/\.0+$/,'');
class Err extends Error{}
const need=(c,m)=>{if(!c)throw new Err(m)};

// ---------- logic ----------
function totals(items){ // items: [{id,g}] -> {t, inc}
  const t={},inc={};NUT.forEach(([k])=>t[k]=0);
  for(const {id,g} of items){const i=ing(id);if(!i)continue;
    for(const [k] of NUT){if(i.n[k]==null)inc[k]=true;else t[k]+=i.n[k]*g/100}}
  return {t,inc};
}
function dayStart(){const s=new Date(Date.now()-3*3600e3);s.setHours(3,0,0,0);return s.getTime()} // day runs 3AM-3AM
function todayMeals(){const s=dayStart();return db.meals.filter(m=>m.at>=s&&m.at<s+864e5)}
function eat(recipeId,portions){
  const r=rec(recipeId);need(r,'Unknown recipe');need(portions>0,'Portions must be > 0');
  const warn=[],items=[];
  for(const it of r.items){const need_=it.g*portions,stock=db.inventory[it.id]||0,ded=Math.min(stock,need_);
    if(ded<need_)warn.push(`${ing(it.id).name}: needed ${fmt(need_)} g, only ${fmt(stock)} g in stock (set to 0)`);
    if(it.id in db.inventory)db.inventory[it.id]-=ded;
    items.push({id:it.id,used:need_,deducted:ded})}
  db.meals.push({id:uid(),recipe_id:r.id,recipe_name:r.name,portions,at:Date.now(),items});save();return warn;
}
function undoEat(){const m=db.meals.pop();need(m,'No meals to undo');
  for(const it of m.items)if(it.deducted>0)db.inventory[it.id]=(db.inventory[it.id]||0)+it.deducted;save();return `Undid ${m.recipe_name}`}
function buy(id,mode,amt,pkg){
  const i=ing(id);need(i,'Choose an ingredient');need(amt>0,'Amount must be > 0');
  const g=mode==='grams'?amt:mode==='servings'?amt*i.serving_g:amt*need_pkg(id,pkg);
  db.inventory[id]=(db.inventory[id]||0)+g;db.purchases.push({id:uid(),ingredient_id:id,grams:g,at:Date.now()});save();return g;
}
function need_pkg(id,pkg){const p=db.packages.filter(p=>p.ingredient_id===id);need(p.length,'No package saved for this ingredient; use servings or grams');
  const s=pkg?+pkg:p.length===1?p[0].size_g:0;need(s,'Choose a package size');return s}
function undoBuy(){const p=db.purchases.pop();need(p,'No purchases to undo');
  db.inventory[p.ingredient_id]=Math.max(0,(db.inventory[p.ingredient_id]||0)-p.grams);save();return `Undid ${fmt(p.grams,0)} g of ${ing(p.ingredient_id)?.name}`}
function saveIngredient(f,serving,name,pkg){
  need(serving>0,'Serving size must be > 0');
  const ex=db.ingredients.find(i=>i.source===f.source&&i.external_id===f.external_id);
  const nm=(name||'').trim()||ex?.name||f.name;
  need(!db.ingredients.some(i=>i.name===nm&&i!==ex),`An ingredient named "${nm}" already exists`);
  const o=ex||{id:uid(),source:f.source,external_id:f.external_id};
  Object.assign(o,{name:nm,serving_g:serving,n:f.n});if(!ex)db.ingredients.push(o);
  if(pkg>0)addPkg(o.id,pkg);save();return o;
}
function addPkg(id,size){need(size>0,'Package size must be > 0');
  if(!db.packages.some(p=>p.ingredient_id===id&&p.size_g===size))db.packages.push({id:uid(),ingredient_id:id,size_g:size});save()}
function delIngredient(id){
  need(!db.recipes.some(r=>r.items.some(x=>x.id===id)),'Used in a recipe; remove it there first');
  need(!db.meals.some(m=>m.items.some(x=>x.id===id))&&!db.purchases.some(p=>p.ingredient_id===id),'Has logged meals/purchases; edit it instead');
  db.ingredients=db.ingredients.filter(i=>i.id!==id);db.packages=db.packages.filter(p=>p.ingredient_id!==id);delete db.inventory[id];save()}
function saveRecipe(d){
  const name=d.name.trim();need(name,'Recipe needs a name');need(d.items.length,'Add at least one ingredient');
  need(!db.recipes.some(r=>r.name===name&&r.id!==d.id),`A recipe named "${name}" already exists`);
  if(d.id)Object.assign(rec(d.id),{name,items:d.items});else db.recipes.push({id:uid(),name,items:d.items});save()}

// ---------- API (per 100 g; null = unknown) ----------
const num=v=>{const x=parseFloat(v);return isFinite(x)?x:null};
const mul=(v,m)=>v==null?null:v*m;
async function getJson(url){let r;try{r=await fetch(url)}catch(e){throw new Err('Network error: '+e.message)}
  if(r.status===404)throw new Err('Not found');if(r.status===401||r.status===403)throw new Err('API key rejected');
  if(!r.ok)throw new Err('API error '+r.status);return r.json()}
async function fetchFood(src,id){
  id=id.trim();need(id,'Enter an ID');
  if(src==='OFF'){
    const d=await getJson(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(id)}.json?fields=product_name,nutriments`);
    need(d.status===1,'No Open Food Facts product for that barcode');const n=d.product.nutriments||{};
    const kj=num(n.energy_100g);
    return {source:'OFF',external_id:id,name:d.product.product_name||'OFF '+id,n:{cal:num(n['energy-kcal_100g'])??(kj==null?null:kj/4.184),
      protein:num(n.proteins_100g),carbs:num(n.carbohydrates_100g),fat:num(n.fat_100g),fiber:num(n.fiber_100g),
      zinc_mg:mul(num(n.zinc_100g),1000),magnesium_mg:mul(num(n.magnesium_100g),1000)}};
  }
  const key=db.settings.usda_key;need(key,'Add your USDA API key in Manage > Settings');
  const d=await getJson(`https://api.nal.usda.gov/fdc/v1/food/${encodeURIComponent(id)}?api_key=${encodeURIComponent(key)}`);
  const by={};for(const f of d.foodNutrients||[]){const k=f.nutrient?.number??f.nutrientNumber??f.number,a=num(f.amount??f.value);if(k!=null&&a!=null)by[String(k)]=a}
  const pick=(...ks)=>{for(const k of ks)if(k in by)return by[k];return null};
  const n={cal:pick('208','957','958'),protein:pick('203'),carbs:pick('205'),fat:pick('204'),fiber:pick('291'),zinc_mg:pick('309'),magnesium_mg:pick('304')};
  // branded-food fallback: label values are per serving -> convert to per 100 g
  const L=d.labelNutrients,ss=num(d.servingSize);
  if(L&&ss&&/^(g|grm)$/i.test(d.servingSizeUnit||'')){const lab={cal:'calories',protein:'protein',carbs:'carbohydrates',fat:'fat',fiber:'fiber'};
    for(const k in lab)if(n[k]==null&&L[lab[k]]?.value!=null)n[k]=L[lab[k]].value*100/ss}
  return {source:'USDA',external_id:id,name:d.description||'USDA '+id,n};
}

// ---------- UI ----------
const S={tab:'today',msg:null,pending:null,editIng:null,draft:null};
const flash=(t,err)=>{S.msg={t,err}};
function render(){
  $('#nav').innerHTML=[['today','Today'],['pantry','Pantry'],['manage','Manage']].map(([k,l])=>`<button class="${S.tab===k?'on':''}" data-a="tab" data-t="${k}">${l}</button>`).join('');
  $('#app').innerHTML=(S.msg?`<div class="msg ${S.msg.err?'err':''}">${esc(S.msg.t)}</div>`:'')+({today,pantry,manage}[S.tab])();S.msg=null;
}
const totalsTable=({t,inc})=>`<table>${NUT.map(([k,l,u])=>`<tr><td>${l}${inc[k]?' *':''}<td>${fmt(t[k])} ${u}`).join('')}</table>`+(Object.keys(inc).length?'<p class="mut">* incomplete: some ingredients have unknown values</p>':'');
function today(){
  const ms=todayMeals(),tt=totals(ms.flatMap(m=>m.items.map(i=>({id:i.id,g:i.used}))));
  return `<h3>Today</h3>${ms.length?`<p class="mut">${ms.map(m=>`${fmt(m.portions,2)} × ${esc(m.recipe_name)}`).join(', ')}</p>`:'<p class="mut">No meals logged today.</p>'}${totalsTable(tt)}
  <h3>Eat</h3>${db.recipes.map(r=>`<div class="row"><b style="flex:1">${esc(r.name)}</b><input type="number" id="p-${r.id}" value="1" step="0.25" min="0"><button data-a="eat" data-id="${r.id}">Eat</button></div>`).join('')||'<p class="mut">Create a recipe in Manage first.</p>'}
  <button class="s" data-a="undoEat">Undo last meal</button>`;
}
function pantry(){
  const rows=db.ingredients.map(i=>({i,g:db.inventory[i.id]||0})).map(x=>({...x,s:Math.floor(x.g/x.i.serving_g+1e-9)}));
  const sel=S.buyIng||db.ingredients[0]?.id,mode=S.buyMode||'package',pk=db.packages.filter(p=>p.ingredient_id===sel);
  return `<h3>Pantry</h3><table><tr><th>Ingredient<th>Grams<th>Servings</tr>${rows.map(({i,g,s})=>`<tr><td>${esc(i.name)}<td>${fmt(g,0)}<td class="${s<=LOW?'low':''}">${s}${s<=LOW?' LOW':''}`).join('')}</table>
  <h3>Buy</h3><div class="row"><select id="bi" data-c="buyIng">${db.ingredients.map(i=>`<option value="${i.id}" ${i.id===sel?'selected':''}>${esc(i.name)}`).join('')}</select>
  <select id="bm" data-c="buyMode">${['package','servings','grams'].map(m=>`<option ${m===mode?'selected':''}>${m}`).join('')}</select>
  <input type="number" id="ba" value="1" step="any" min="0">${mode==='package'&&pk.length>1?`<select id="bp">${pk.map(p=>`<option value="${p.size_g}">${p.size_g} g`).join('')}</select>`:''}
  <button data-a="buy">Buy</button></div><button class="s" data-a="undoBuy">Undo last purchase</button>`;
}
function readDraft(){if(!S.draft)return;S.draft.name=$('#rn')?.value??S.draft.name;
  S.draft.items.forEach((it,k)=>{const e=$('#rg'+k);if(e)it.g=parseFloat(e.value)||0})}
function manage(){
  let h=`<h3>Add ingredient</h3><div class="row"><select id="src"><option>OFF<option>USDA</select><input id="eid" placeholder="Barcode / FDC ID"><button data-a="fetch">Fetch</button></div>`;
  if(S.pending){const f=S.pending;h+=`<div class="card"><b>Preview (per 100 g)</b><table>${NUT.map(([k,l,u])=>`<tr><td>${l}<td>${fmt(f.n[k])} ${u}`).join('')}</table>
    <input id="pn" value="${esc(f.name)}" style="width:100%"><div class="row"><input type="number" id="ps" placeholder="Serving g"><input type="number" id="pp" placeholder="Package g (opt.)"></div>
    <button data-a="savePending">Save</button> <button class="s" data-a="cancelPending">Cancel</button></div>`}
  h+=`<h3>Ingredients</h3>`+db.ingredients.map(i=>S.editIng===i.id?editForm(i):`<div class="card"><b>${esc(i.name)}</b> <span class="mut">serving ${fmt(i.serving_g)} g${db.packages.filter(p=>p.ingredient_id===i.id).map(p=>' · pkg '+p.size_g+' g').join('')}</span><div class="row">
    <button class="s" data-a="editIng" data-id="${i.id}">Edit</button><button class="s" data-a="addPkg" data-id="${i.id}">+ Package</button><button class="d" data-a="delIng" data-id="${i.id}">Delete</button></div></div>`).join('');
  const d=S.draft;
  h+=`<h3>Recipes</h3>`+(d?`<div class="card"><b>${d.id?'Edit':'New'} recipe</b><input id="rn" value="${esc(d.name)}" placeholder="Recipe name" style="width:100%">
    ${d.items.map((it,k)=>`<div class="row"><span style="flex:1">${esc(ing(it.id)?.name)}</span><input type="number" id="rg${k}" value="${it.g||''}" placeholder="g" step="any"><button class="s" data-a="rmItem" data-k="${k}">✕</button></div>`).join('')}
    <div class="row"><select id="ri">${db.ingredients.map(i=>`<option value="${i.id}">${esc(i.name)}`).join('')}</select><input type="number" id="rg" placeholder="grams" step="any"><button class="s" data-a="addItem">Add</button></div>
    <button data-a="saveRecipe">Save recipe</button> <button class="s" data-a="cancelDraft">Cancel</button></div>`:`<button data-a="newRecipe">New recipe</button>`)
   +db.recipes.map(r=>`<div class="card"><b>${esc(r.name)}</b><div class="mut">${r.items.map(x=>`${esc(ing(x.id)?.name)} ${fmt(x.g)} g`).join(' · ')}</div>${totalsTable(totals(r.items.map(x=>({id:x.id,g:x.g}))))}
    <div class="row"><button class="s" data-a="editRec" data-id="${r.id}">Edit</button><button class="s" data-a="copyRec" data-id="${r.id}">Copy</button><button class="d" data-a="delRec" data-id="${r.id}">Delete</button></div></div>`).join('');
  return h+`<h3>Settings & backup</h3><input id="key" placeholder="USDA API key" value="${esc(db.settings.usda_key)}" style="width:100%"><button data-a="saveKey">Save key</button>
   <div class="row"><button class="s" data-a="export">Export backup</button><input type="file" id="imp" accept=".json"><button class="s" data-a="import">Import</button></div>`;
}
function editForm(i){return `<div class="card"><b>Edit ${esc(i.name)}</b> <span class="mut">(per 100 g; blank = unknown, required fields cannot be blank)</span><input id="en" value="${esc(i.name)}" style="width:100%"><div class="row">
  <input type="number" id="es" value="${i.serving_g}" step="any"> <span class="mut">serving g</span></div>${NUT.map(([k,l,u])=>`<div class="row"><input type="number" id="e-${k}" value="${i.n[k]??''}" step="any"> <span class="mut">${l} (${u})</span></div>`).join('')}
  <button data-a="saveIng" data-id="${i.id}">Save</button> <button class="s" data-a="cancelEdit">Cancel</button></div>`}

// ---------- events ----------
const A={
  tab:d=>{S.tab=d.t},
  eat:d=>{const w=eat(d.id,parseFloat($('#p-'+d.id).value)||1);flash(w.length?'Logged. Warning: '+w.join('; '):'Meal logged',!!w.length)},
  undoEat:()=>flash(undoEat()),undoBuy:()=>flash(undoBuy()),
  buy:()=>{const g=buy($('#bi').value,$('#bm').value,parseFloat($('#ba').value),$('#bp')?.value);flash(`Added ${fmt(g,0)} g`)},
  fetch:async()=>{try{S.pending=await fetchFood($('#src').value,$('#eid').value);const m=REQ.filter(k=>S.pending.n[k]==null);
    if(m.length){S.pending=null;flash(`Missing required data (${m.join(', ')}). Try a different FDC ID or barcode.`,true)}}catch(e){flash(e.message,true)}render()},
  savePending:()=>{const o=saveIngredient(S.pending,parseFloat($('#ps').value),$('#pn').value,parseFloat($('#pp').value));S.pending=null;flash('Saved '+o.name)},
  cancelPending:()=>{S.pending=null},
  editIng:d=>{S.editIng=d.id},cancelEdit:()=>{S.editIng=null},
  saveIng:d=>{const i=ing(d.id),n={};NUT.forEach(([k])=>{const v=$('#e-'+k).value;n[k]=v===''?null:parseFloat(v)});
    const miss=REQ.filter(k=>n[k]==null);need(!miss.length,'Required: '+miss.join(', '));const s=parseFloat($('#es').value),nm=$('#en').value.trim();
    need(s>0,'Serving size must be > 0');need(nm&&!db.ingredients.some(x=>x.name===nm&&x!==i),'Name empty or already used');
    Object.assign(i,{name:nm,serving_g:s,n});save();S.editIng=null;flash('Saved')},
  addPkg:d=>{const g=parseFloat(prompt('Package size in grams'));if(g){addPkg(d.id,g);flash('Package saved')}},
  delIng:d=>{if(confirm('Delete this ingredient?')){delIngredient(d.id);flash('Deleted')}},
  newRecipe:()=>{S.draft={id:null,name:'',items:[]}},cancelDraft:()=>{S.draft=null},
  editRec:d=>{const r=rec(d.id);S.draft={id:r.id,name:r.name,items:r.items.map(x=>({...x}))}},
  copyRec:d=>{const r=rec(d.id);S.draft={id:null,name:r.name+' (copy)',items:r.items.map(x=>({...x}))}},
  addItem:()=>{readDraft();const id=$('#ri').value,g=parseFloat($('#rg').value);need(id&&g>0,'Choose an ingredient and grams');
    need(!S.draft.items.some(x=>x.id===id),'Already in this recipe');S.draft.items.push({id,g})},
  rmItem:d=>{readDraft();S.draft.items.splice(+d.k,1)},
  saveRecipe:()=>{readDraft();need(S.draft.items.every(x=>x.g>0),'Every ingredient needs grams > 0');saveRecipe(S.draft);S.draft=null;flash('Recipe saved')},
  delRec:d=>{if(confirm('Delete this recipe? Past meal logs are kept.')){db.recipes=db.recipes.filter(r=>r.id!==d.id);save()}},
  saveKey:()=>{db.settings.usda_key=$('#key').value.trim();save();flash('Key saved')},
  export:()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(db,null,1)],{type:'application/json'}));
    a.download=`nutrition-backup-${new Date().toISOString().slice(0,10)}.json`;a.click()},
  import:async()=>{const f=$('#imp').files[0];need(f,'Choose a backup file first');const d=JSON.parse(await f.text());
    need(d.ingredients&&d.recipes&&d.meals&&d.inventory,'Not a valid backup');if(confirm('Replace ALL current data?')){db=d;save();flash('Imported')}}
};
document.addEventListener('click',async e=>{const b=e.target.closest('[data-a]');if(!b)return;
  try{await A[b.dataset.a](b.dataset)}catch(x){flash(x instanceof Err?x.message:'Error: '+x.message,true)}render()});
document.addEventListener('change',e=>{const c=e.target.dataset.c;if(!c)return;
  if(c==='buyIng')S.buyIng=e.target.value;if(c==='buyMode')S.buyMode=e.target.value;render()});
if('serviceWorker'in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
render();
