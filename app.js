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
const live=()=>db.ingredients.filter(i=>!i.hidden);
const svc=(g,i)=>Math.floor(g/i.serving_g+0.05+1e-9); // stock within 5% under a full serving counts as a full serving
function need_pkg(id,pkg){const p=db.packages.filter(p=>p.ingredient_id===id);need(p.length,'No package saved for this ingredient; use servings or grams');
  const s=pkg?+pkg:p.length===1?p[0].size_g:0;need(s,'Choose a package size');return s}
function adjust(id,sign,mode,amt,pkg){ // sign +1 add, -1 remove; returns signed grams applied
  const i=ing(id),stock=db.inventory[id]||0;need(i,'Unknown ingredient');let g;
  if(mode==='all')g=stock;else{need(amt>0,'Amount must be > 0');g=mode==='grams'?amt:mode==='servings'?amt*i.serving_g:amt*need_pkg(id,pkg)}
  if(sign<0)g=-Math.min(stock,g);need(g!==0,'Nothing to change');
  db.inventory[id]=stock+g;db.purchases.push({id:uid(),ingredient_id:id,grams:g,at:Date.now()});save();return g}
function undoBuy(){const p=db.purchases.pop();need(p,'No changes to undo');
  db.inventory[p.ingredient_id]=Math.max(0,(db.inventory[p.ingredient_id]||0)-p.grams);save();
  return `Undid ${p.grams>0?'purchase':'removal'} of ${fmt(Math.abs(p.grams),0)} g ${ing(p.ingredient_id)?.name}`}
function saveIngredient(f,serving,name,pkg,meta={}){
  need(serving>0,'Serving size must be > 0');
  const ex=db.ingredients.find(i=>i.source===f.source&&i.external_id===f.external_id);
  const nm=(name||'').trim()||ex?.name||f.name;
  need(!db.ingredients.some(i=>i.name===nm&&i!==ex&&!i.hidden),`An ingredient named "${nm}" already exists`);
  const o=ex||{id:uid(),source:f.source,external_id:f.external_id};
  const m={};for(const k of['emoji','category','group'])if((meta[k]||'').trim())m[k]=meta[k].trim();
  Object.assign(o,{name:nm,serving_g:serving,n:f.n,hidden:false},m);if(!ex)db.ingredients.push(o);
  if(pkg>0)addPkg(o.id,pkg);save();return o}
function addPkg(id,size){need(size>0,'Package size must be > 0');
  if(!db.packages.some(p=>p.ingredient_id===id&&p.size_g===size))db.packages.push({id:uid(),ingredient_id:id,size_g:size});save()}
function delIngredient(id){ // hidden, not erased, so past meal history keeps its numbers
  const i=ing(id);need(i,'Unknown ingredient');i.hidden=true;db.recipes.forEach(r=>r.items=r.items.filter(x=>x.id!==id));
  db.packages=db.packages.filter(p=>p.ingredient_id!==id);delete db.inventory[id];save()}
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
const S={tab:'today',msg:null,pending:null,editIng:null,draft:null,open:{},adj:null};
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
const catOf=i=>i.category||'Uncategorized';
function nutTable(i){return `<table class="mut"><tr><th colspan="2">Per serving (${fmt(i.serving_g)} g)</tr>`+NUT.map(([k,l,u])=>`<tr><td>${l}<td>${i.n[k]==null?'?':fmt(i.n[k]*i.serving_g/100)+' '+u}`).join('')+'</table>'}
function adjPanel(i){const a=S.adj;if(!a||a.id!==i.id)return'';const pk=db.packages.filter(p=>p.ingredient_id===i.id);
  const modes=a.sign>0?[...(pk.length?['package']:[]),'servings','grams']:['servings','grams','all'],m=modes.includes(a.mode)?a.mode:modes[0];
  return `<div class="card"><div class="row"><b>${a.sign>0?'Add':'Remove'}</b><select id="am" data-c="adjMode">${modes.map(x=>`<option ${x===m?'selected':''}>${x}`).join('')}</select>
  ${m==='all'?'<span class="mut">zero out</span>':'<input type="number" id="aa" value="1" step="any" min="0">'}${m==='package'&&pk.length>1?`<select id="ap">${pk.map(p=>`<option value="${p.size_g}">${p.size_g} g`).join('')}</select>`:''}
  <button data-a="applyAdj">Apply</button><button class="s" data-a="cancelAdj">Cancel</button></div></div>`}
function pRow(i){const g=db.inventory[i.id]||0,s=svc(g,i),k='p-'+i.id;
  return `<details data-k="${k}" ${S.open[k]?'open':''}><summary class="row"><span style="flex:1">${esc(i.emoji||'')} ${esc(i.name)}<br><span class="mut">${fmt(g,0)} g</span></span><b class="${s<=LOW?'low':''}">${s}${s<=LOW?' LOW':''}</b>
  <button class="s" data-a="adj" data-id="${i.id}" data-s="-1">−</button><button data-a="adj" data-id="${i.id}" data-s="1">+</button></summary>${adjPanel(i)}${nutTable(i)}</details>`}
function pantry(){
  const by={};live().forEach(i=>(by[catOf(i)]??=[]).push(i));
  let h='<h3>Pantry</h3><p class="mut">Servings left · tap a row for nutrition</p>';
  for(const c of Object.keys(by).sort()){h+=`<h3>${esc(c)}</h3>`;const gs={};by[c].forEach(i=>(gs[i.group||'\0'+i.id]??=[]).push(i));
    for(const key of Object.keys(gs).sort()){const l=gs[key].sort((a,b)=>a.name.localeCompare(b.name));
      h+=key[0]==='\0'||l.length===1?l.map(pRow).join(''):`<div class="card"><b>${esc(l[0].group)}</b> <span class="mut">${l.reduce((a,i)=>a+svc(db.inventory[i.id]||0,i),0)} servings total</span>${l.map(pRow).join('')}</div>`}}
  return h+`<div class="row" style="margin-top:16px"><button class="s" data-a="undoBuy">Undo last change</button><button class="d" data-a="resetStock">Reset all stock to 0</button></div>`}
function readDraft(){if(!S.draft)return;S.draft.name=$('#rn')?.value??S.draft.name;
  S.draft.items.forEach((it,k)=>{const e=$('#rg'+k);if(e)it.g=parseFloat(e.value)||0})}
function ingCard(i){
  if(S.editIng===i.id)return editForm(i);const pk=db.packages.filter(p=>p.ingredient_id===i.id).map(p=>p.size_g+' g').join(', ');
  return `<div class="row card"><span style="flex:1"><span style="font-size:20px">${esc(i.emoji||'')}</span> <b>${esc(i.name)}</b><br><span class="mut">${i.group?esc(i.group)+' · ':''}serving ${fmt(i.serving_g)} g${pk?' · packages: '+pk:''}</span></span><button class="s" data-a="editIng" data-id="${i.id}">Edit</button></div>`}
function recipeCard(r){const k='r-'+r.id,t=totals(r.items);
  return `<details data-k="${k}" ${S.open[k]?'open':''}><summary><b>${esc(r.name)}</b> <span class="mut">${fmt(t.t.cal,0)} kcal · ${fmt(t.t.protein)} g protein</span></summary>
  <table><tr><th>Ingredient<th>g<th>kcal<th>P<th>C<th>F</tr>${r.items.map(x=>{const q=totals([x]).t,i=ing(x.id);return `<tr><td>${esc(i?.emoji||'')} ${esc(i?.name)}<td>${fmt(x.g)}<td>${fmt(q.cal,0)}<td>${fmt(q.protein)}<td>${fmt(q.carbs)}<td>${fmt(q.fat)}`}).join('')}</table>${totalsTable(t)}
  <div class="row"><button class="s" data-a="editRec" data-id="${r.id}">Edit</button><button class="s" data-a="copyRec" data-id="${r.id}">Copy</button><button class="d" data-a="delRec" data-id="${r.id}">Delete</button></div></details>`}
function manage(){
  let h=`<datalist id="cats">${[...new Set(live().map(catOf))].map(c=>`<option value="${esc(c)}">`).join('')}</datalist><h3>Add ingredient</h3><div class="row"><select id="src"><option>OFF<option>USDA</select><input id="eid" placeholder="Barcode / FDC ID"><button data-a="fetch">Fetch</button></div>`;
  if(S.pending){const f=S.pending;h+=`<div class="card"><b>Preview (per 100 g)</b><table>${NUT.map(([k,l,u])=>`<tr><td>${l}<td>${fmt(f.n[k])} ${u}`).join('')}</table>
    <input id="pn" value="${esc(f.name)}" style="width:100%"><div class="row"><input id="pe" placeholder="Emoji" size="6"><input id="pc" list="cats" placeholder="Category"><input id="pg" placeholder="Group (e.g. Tortillas)"></div>
    <div class="row"><input type="number" id="ps" placeholder="Serving g"><input type="number" id="pp" placeholder="Package g (opt.)"></div>
    <button data-a="savePending">Save</button> <button class="s" data-a="cancelPending">Cancel</button></div>`}
  const by={};live().forEach(i=>(by[catOf(i)]??=[]).push(i));
  h+='<h3>Ingredients</h3>'+Object.keys(by).sort().map(c=>{const k='c-'+c;return `<details data-k="${k}" ${S.open[k]===false?'':'open'}><summary><b>${esc(c)}</b> <span class="mut">(${by[c].length})</span></summary>${by[c].sort((a,b)=>(a.group||'').localeCompare(b.group||'')||a.name.localeCompare(b.name)).map(ingCard).join('')}</details>`}).join('');
  const d=S.draft;
  h+=`<h3>Recipes</h3>`+(d?`<div class="card"><b>${d.id?'Edit':'New'} recipe</b><input id="rn" value="${esc(d.name)}" placeholder="Recipe name" style="width:100%">
    ${d.items.map((it,k)=>`<div class="row"><span style="flex:1">${esc(ing(it.id)?.name)}</span><input type="number" id="rg${k}" value="${it.g||''}" placeholder="g" step="any"><button class="s" data-a="rmItem" data-k="${k}">✕</button></div>`).join('')}
    <div class="row"><select id="ri">${live().map(i=>`<option value="${i.id}">${esc(i.name)}`).join('')}</select><input type="number" id="rg" placeholder="grams" step="any"><button class="s" data-a="addItem">Add</button></div>
    <button data-a="saveRecipe">Save recipe</button> <button class="s" data-a="cancelDraft">Cancel</button></div>`:`<button data-a="newRecipe">New recipe</button>`)
   +[...db.recipes].sort((a,b)=>a.name.localeCompare(b.name)).map(recipeCard).join('');
  return h+`<h3>Settings & backup</h3><input id="key" placeholder="USDA API key" value="${esc(db.settings.usda_key)}" style="width:100%"><button data-a="saveKey">Save key</button>
   <div class="row"><button class="s" data-a="export">Export backup</button><input type="file" id="imp" accept=".json"><button class="s" data-a="import">Import</button></div>`}
function editForm(i){return `<div class="card"><b>Edit ${esc(i.name)}</b><input id="en" value="${esc(i.name)}" style="width:100%">
  <div class="row"><input id="ee" value="${esc(i.emoji||'')}" placeholder="Emoji" size="6"><input id="ec" list="cats" value="${esc(i.category||'')}" placeholder="Category"><input id="eg" value="${esc(i.group||'')}" placeholder="Group (e.g. Tortillas)"></div>
  <div class="row"><input type="number" id="es" value="${i.serving_g}" step="any"> <span class="mut">serving g</span></div>
  <p class="mut">Per 100 g (blank = unknown; first four required)</p>${NUT.map(([k,l,u])=>`<div class="row"><input type="number" id="e-${k}" value="${i.n[k]??''}" step="any"> <span class="mut">${l} (${u})</span></div>`).join('')}
  <p class="mut">Package sizes (✕ or blank removes)</p>${db.packages.filter(p=>p.ingredient_id===i.id).map(p=>`<div class="row"><input type="number" id="pk-${p.id}" value="${p.size_g}" step="any"><span class="mut">g</span><button class="s" data-a="clrPkg" data-id="${p.id}">✕</button></div>`).join('')}
  <div class="row"><input type="number" id="pk-new" placeholder="Add package g" step="any"></div>
  <div class="row"><button data-a="saveIng" data-id="${i.id}">Save</button><button class="s" data-a="cancelEdit">Cancel</button><button class="d" data-a="delIng" data-id="${i.id}">Delete ingredient</button></div></div>`}

// ---------- events ----------
const A={
  tab:d=>{S.tab=d.t},
  eat:d=>{const w=eat(d.id,parseFloat($('#p-'+d.id).value)||1);flash(w.length?'Logged. Warning: '+w.join('; '):'Meal logged',!!w.length)},
  undoEat:()=>flash(undoEat()),undoBuy:()=>flash(undoBuy()),
  adj:d=>{S.adj={id:d.id,sign:+d.s,mode:null};S.open['p-'+d.id]=true},cancelAdj:()=>{S.adj=null},
  applyAdj:()=>{const a=S.adj,g=adjust(a.id,a.sign,$('#am').value,parseFloat($('#aa')?.value),$('#ap')?.value);S.adj=null;flash(`${g>0?'Added':'Removed'} ${fmt(Math.abs(g),0)} g`)},
  resetStock:()=>{if(confirm('Set ALL pantry stock to 0? This cannot be undone.')){for(const k in db.inventory)db.inventory[k]=0;save();flash('All stock reset to 0')}},
  fetch:async()=>{try{S.pending=await fetchFood($('#src').value,$('#eid').value);const m=REQ.filter(k=>S.pending.n[k]==null);
    if(m.length){S.pending=null;flash(`Missing required data (${m.join(', ')}). Try a different FDC ID or barcode.`,true)}}catch(e){flash(e.message,true)}render()},
  savePending:()=>{const o=saveIngredient(S.pending,parseFloat($('#ps').value),$('#pn').value,parseFloat($('#pp').value),{emoji:$('#pe').value,category:$('#pc').value,group:$('#pg').value});S.pending=null;flash('Saved '+o.name)},
  cancelPending:()=>{S.pending=null},
  editIng:d=>{S.editIng=d.id},cancelEdit:()=>{S.editIng=null},
  clrPkg:d=>{$('#pk-'+d.id).value='';return 'nr'},
  saveIng:d=>{const i=ing(d.id),n={};NUT.forEach(([k])=>{const v=$('#e-'+k).value;n[k]=v===''?null:parseFloat(v)});
    const miss=REQ.filter(k=>n[k]==null);need(!miss.length,'Required: '+miss.join(', '));const s=parseFloat($('#es').value),nm=$('#en').value.trim();
    need(s>0,'Serving size must be > 0');need(nm&&!db.ingredients.some(x=>x.name===nm&&x!==i&&!x.hidden),'Name empty or already used');
    const mine=db.packages.filter(p=>p.ingredient_id===i.id),vals=mine.map(p=>[p,parseFloat($('#pk-'+p.id).value)]),nw=parseFloat($('#pk-new').value);
    const sizes=vals.map(x=>x[1]).filter(v=>v>0);if(nw>0)sizes.push(nw);need(new Set(sizes).size===sizes.length,'Duplicate package sizes');
    db.packages=db.packages.filter(p=>!mine.includes(p)||vals.find(x=>x[0]===p)[1]>0);vals.forEach(([p,v])=>{if(v>0)p.size_g=v});
    if(nw>0)db.packages.push({id:uid(),ingredient_id:i.id,size_g:nw});
    Object.assign(i,{name:nm,serving_g:s,n,emoji:$('#ee').value.trim(),category:$('#ec').value.trim(),group:$('#eg').value.trim()});save();S.editIng=null;flash('Saved')},
  delIng:d=>{if(confirm('Delete this ingredient? It is removed from recipes and lists; past meal history is kept.')){delIngredient(d.id);S.editIng=null;flash('Deleted')}},
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
document.addEventListener('click',async e=>{const b=e.target.closest('[data-a]');if(!b)return;if(b.closest('summary'))e.preventDefault();let r;
  try{r=await A[b.dataset.a](b.dataset)}catch(x){flash(x instanceof Err?x.message:'Error: '+x.message,true)}if(r!=='nr')render()});
document.addEventListener('change',e=>{if(e.target.dataset.c==='adjMode'){S.adj.mode=e.target.value;render()}});
document.addEventListener('toggle',e=>{const k=e.target.dataset?.k;if(k)S.open[k]=e.target.open},true);
if('serviceWorker'in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
render();
