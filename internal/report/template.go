package report

// reportHTML is the self-contained template for the enrichment coverage report.
// All CSS is inline so the file opens standalone from reports/ with no
// dependency on the built site's assets. Palette mirrors assets/css/site.css.
const reportHTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>FineVines — Enrichment Coverage</title>
<style>
  :root{
    --bordeaux:#531427; --bordeaux-900:#3d0e1c; --brass:#c2a14e; --brass-dark:#a9853d;
    --parchment:#faf6ee; --parchment-2:#f4ece0; --line:#e2d6c2;
    --ink:#2c211a; --ink-soft:#6e5d4e;
    --sf:#2f6b3f; --found:#2a6b7c; --derived:#b07d1a; --missing:#ccc0ad;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--parchment);color:var(--ink);
    font:15px/1.5 "Segoe UI",system-ui,-apple-system,sans-serif;}
  header{background:var(--bordeaux);color:#f7efe0;padding:26px 32px;}
  header h1{margin:0;font:600 24px/1.2 Georgia,"Times New Roman",serif;letter-spacing:.3px;}
  header .note{margin:6px 0 0;color:#e6cfa0;font-size:13.5px;}
  main{padding:24px 32px 60px;max-width:1400px;margin:0 auto;}
  .cards{display:flex;flex-wrap:wrap;gap:16px;margin:0 0 26px;}
  .card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:16px 20px;min-width:160px;flex:1;}
  .card .k{font-size:12px;text-transform:uppercase;letter-spacing:1.2px;color:var(--ink-soft);}
  .card .v{font:600 28px/1.1 Georgia,serif;margin-top:6px;color:var(--bordeaux);}
  .card .sub{font-size:12.5px;color:var(--ink-soft);margin-top:3px;}
  .legend{display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin:0 0 16px;font-size:13px;color:var(--ink-soft);}
  .legend b{color:var(--ink);font-weight:600;}
  .chip{display:inline-flex;align-items:center;gap:6px;}
  .sw{width:15px;height:15px;border-radius:3px;display:inline-block;}
  .src-salesforce{background:var(--sf)} .src-found{background:var(--found)}
  .src-derived{background:var(--derived)} .src-missing{background:var(--missing)}
  .tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:#fff;}
  table{border-collapse:collapse;width:100%;font-size:13px;}
  thead th{position:sticky;top:0;background:var(--parchment-2);color:var(--ink);
    font-weight:600;text-align:center;padding:9px 6px;border-bottom:2px solid var(--line);white-space:nowrap;}
  thead th.wine,thead th.num{text-align:left;}
  tbody td{padding:7px 6px;border-bottom:1px solid #efe6d6;text-align:center;vertical-align:middle;}
  tbody tr:hover{background:#fbf6ec;}
  td.num{color:var(--ink-soft);text-align:right;padding-right:10px;width:34px;}
  td.wine{text-align:left;min-width:230px;}
  td.wine .nm{font-weight:600;color:var(--bordeaux-900);}
  td.wine .meta{color:var(--ink-soft);font-size:12px;}
  td.wine .sku{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;color:var(--ink-soft);}
  .score{display:flex;align-items:center;gap:8px;min-width:104px;}
  .bar{flex:1;height:8px;border-radius:5px;background:#eee3d0;overflow:hidden;}
  .bar i{display:block;height:100%;}
  .band-high i{background:var(--sf)} .band-mid i{background:var(--brass-dark)} .band-low i{background:var(--bordeaux)}
  .score b{width:30px;text-align:right;font-variant-numeric:tabular-nums;}
  .band-high b{color:var(--sf)} .band-mid b{color:var(--brass-dark)} .band-low b{color:var(--bordeaux)}
  .cellsrc{width:30px;height:24px;border-radius:4px;color:#fff;font-weight:600;font-size:11px;
    line-height:24px;text-align:center;margin:0 auto;}
  .src-missing.cellsrc{color:#6e5d4e;}
  td.match{font-variant-numeric:tabular-nums;color:var(--ink-soft);}
  footer{color:var(--ink-soft);font-size:12px;margin-top:20px;text-align:center;}
</style>
</head>
<body>
<header>
  <h1>FineVines — Enrichment Coverage</h1>
  <p class="note">{{.GeneratedNote}} · sorted worst-coverage-first · internal worklist (not published)</p>
</header>
<main>
  <section class="cards">
    <div class="card"><div class="k">Wines</div><div class="v">{{.Total}}</div></div>
    <div class="card"><div class="k">Avg coverage</div><div class="v">{{.AvgScore}}%</div>
      <div class="sub">real vs. inferred metadata</div></div>
    <div class="card"><div class="k">Need attention</div><div class="v">{{.NeedAttention}}</div>
      <div class="sub">{{.AttentionPct}}% below 50% coverage</div></div>
    <div class="card"><div class="k">Real images</div><div class="v">{{.ImageRealPct}}%</div>
      <div class="sub">{{.ImageReal}} sourced, rest generated</div></div>
    <div class="card"><div class="k">Avg match conf.</div><div class="v">{{.AvgMatch}}%</div>
      <div class="sub">right-wine confidence</div></div>
  </section>

  <div class="legend">
    <span class="chip"><span class="sw src-salesforce"></span><b>S</b> Salesforce</span>
    <span class="chip"><span class="sw src-found"></span><b>F</b> Found (web)</span>
    <span class="chip"><span class="sw src-derived"></span><b>D</b> Derived</span>
    <span class="chip"><span class="sw src-missing"></span><b>·</b> Missing</span>
    <span style="margin-left:auto">Coverage = share of fields that are S or F.</span>
  </div>

  <div class="tablewrap">
    <table>
      <thead>
        <tr>
          <th class="num">#</th>
          <th class="wine">Wine</th>
          <th>Coverage</th>
          <th>Match</th>
          {{range .Headers}}<th>{{.}}</th>{{end}}
        </tr>
      </thead>
      <tbody>
        {{range $i, $r := .Rows}}
        <tr>
          <td class="num">{{add $i 1}}</td>
          <td class="wine">
            <div class="nm">{{$r.Wine.Producer}}</div>
            <div class="meta">{{$r.Wine.Name}}{{if $r.Wine.Vintage}} · {{$r.Wine.Vintage}}{{end}}</div>
            <div class="sku">{{$r.Wine.SKU}}</div>
          </td>
          <td>
            <div class="score {{$r.Band}}">
              <span class="bar"><i style="width:{{$r.Wine.MetadataScore}}%"></i></span>
              <b>{{$r.Wine.MetadataScore}}</b>
            </div>
          </td>
          <td class="match">{{$r.Wine.MatchConfidence}}%</td>
          {{range $r.Cells}}<td><div class="cellsrc {{.Class}}" title="{{.Title}}">{{.Glyph}}</div></td>{{end}}
        </tr>
        {{end}}
      </tbody>
    </table>
  </div>
  <footer>FineVines enrichment coverage · generated by <code>finevines report</code></footer>
</main>
</body>
</html>
`
