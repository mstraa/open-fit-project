/* ============================================================
   Open Fit — shared client behavior + lightweight SVG charts.
   No external libraries (Garmin-class look, but self-contained).
   ============================================================ */
(function () {
  'use strict';

  /* ---------- mobile drawer ---------- */
  function initDrawer() {
    var rail = document.querySelector('.rail');
    var btn = document.querySelector('.menu-btn');
    var scrim = document.querySelector('.scrim');
    if (!rail || !btn) return;
    function open() { rail.classList.add('is-open'); if (scrim) scrim.classList.add('is-open'); }
    function close() { rail.classList.remove('is-open'); if (scrim) scrim.classList.remove('is-open'); }
    btn.addEventListener('click', open);
    if (scrim) scrim.addEventListener('click', close);
    rail.addEventListener('click', function (e) { if (e.target.closest('a')) close(); });
  }

  /* ---------- seg / tabs (visual toggle) ---------- */
  function initSegs() {
    document.querySelectorAll('.seg, [data-tabs]').forEach(function (group) {
      group.addEventListener('click', function (e) {
        var b = e.target.closest('button'); if (!b) return;
        group.querySelectorAll('button').forEach(function (x) { x.classList.remove('is-active'); });
        b.classList.add('is-active');
        group.dispatchEvent(new CustomEvent('segchange', { detail: { value: b.dataset.value || b.textContent } }));
      });
    });
  }

  /* ---------- helpers ---------- */
  var NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  function extent(arr) { return [Math.min.apply(null, arr), Math.max.apply(null, arr)]; }

  // Catmull-Rom -> bezier smoothing for a value series
  function smoothPath(pts) {
    if (pts.length < 2) return '';
    var d = 'M' + pts[0][0] + ',' + pts[0][1];
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      var c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      var c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += 'C' + c1x + ',' + c1y + ' ' + c2x + ',' + c2y + ' ' + p2[0] + ',' + p2[1];
    }
    return d;
  }

  /* ---------- line / area chart ----------
     opts: { data:[n...], color, fill, height, min, max, smooth, grid, baseline } */
  function lineChart(svg, opts) {
    var data = opts.data;
    var W = svg.viewBox.baseVal.width || svg.clientWidth || 600;
    var H = svg.viewBox.baseVal.height || opts.height || 160;
    var padT = opts.padT != null ? opts.padT : 8, padB = opts.padB != null ? opts.padB : 8;
    var color = opts.color || 'var(--accent)';
    var ex = extent(data);
    var min = opts.min != null ? opts.min : ex[0] - (ex[1] - ex[0]) * 0.12;
    var max = opts.max != null ? opts.max : ex[1] + (ex[1] - ex[0]) * 0.12;
    if (max === min) max = min + 1;
    var sx = function (i) { return (i / (data.length - 1)) * W; };
    var sy = function (v) { return padT + (1 - (v - min) / (max - min)) * (H - padT - padB); };

    while (svg.firstChild) svg.removeChild(svg.firstChild);

    if (opts.grid) {
      for (var g = 0; g <= opts.grid; g++) {
        var gy = padT + (g / opts.grid) * (H - padT - padB);
        svg.appendChild(el('line', { x1: 0, y1: gy, x2: W, y2: gy, stroke: 'var(--border)', 'stroke-width': 1, opacity: .5 }));
      }
    }

    var pts = data.map(function (v, i) { return [sx(i), sy(v)]; });
    var dPath = opts.smooth !== false ? smoothPath(pts) : 'M' + pts.map(function (p) { return p.join(','); }).join('L');

    if (opts.fill !== false) {
      var gid = 'g' + Math.floor(Math.abs(Math.sin(data[0] + data.length)) * 1e6);
      var grad = el('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
      grad.appendChild(el('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': opts.fillOpacity || .28 }));
      grad.appendChild(el('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0 }));
      var defs = el('defs', {}); defs.appendChild(grad); svg.appendChild(defs);
      var area = el('path', { d: dPath + 'L' + W + ',' + H + 'L0,' + H + 'Z', fill: 'url(#' + gid + ')' });
      svg.appendChild(area);
    }
    var line = el('path', { d: dPath, fill: 'none', stroke: color, 'stroke-width': opts.width || 2.4, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
    svg.appendChild(line);

    if (opts.dotLast) {
      var last = pts[pts.length - 1];
      svg.appendChild(el('circle', { cx: last[0] - 1.5, cy: last[1], r: 3.5, fill: color }));
    }
    return { sx: sx, sy: sy, W: W, H: H };
  }

  /* ---------- multi-series overlay (e.g. HR + power) ---------- */
  function multiChart(svg, series, opts) {
    opts = opts || {};
    var W = svg.viewBox.baseVal.width, H = svg.viewBox.baseVal.height;
    var padT = 10, padB = 10;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var grid = opts.grid || 4;
    for (var g = 0; g <= grid; g++) {
      var gy = padT + (g / grid) * (H - padT - padB);
      svg.appendChild(el('line', { x1: 0, y1: gy, x2: W, y2: gy, stroke: 'var(--border)', 'stroke-width': 1, opacity: .45 }));
    }
    series.forEach(function (s) {
      var ex = extent(s.data);
      var min = s.min != null ? s.min : ex[0] - (ex[1] - ex[0]) * .15;
      var max = s.max != null ? s.max : ex[1] + (ex[1] - ex[0]) * .15;
      if (max === min) max = min + 1;
      var pts = s.data.map(function (v, i) {
        return [(i / (s.data.length - 1)) * W, padT + (1 - (v - min) / (max - min)) * (H - padT - padB)];
      });
      svg.appendChild(el('path', { d: smoothPath(pts), fill: 'none', stroke: s.color, 'stroke-width': s.width || 2, 'stroke-linejoin': 'round', opacity: s.opacity || 1 }));
    });
  }

  /* ---------- bar chart ---------- */
  function barChart(svg, data, opts) {
    opts = opts || {};
    var W = svg.viewBox.baseVal.width, H = svg.viewBox.baseVal.height;
    var padB = opts.padB || 18, padT = opts.padT || 6;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var max = opts.max != null ? opts.max : Math.max.apply(null, data.map(function (d) { return d.v; })) * 1.15;
    var n = data.length;
    var bw = (W / n) * (opts.bw || 0.56);
    data.forEach(function (d, i) {
      var x = (i + 0.5) * (W / n) - bw / 2;
      var h = (d.v / max) * (H - padB - padT);
      var y = H - padB - h;
      svg.appendChild(el('rect', { x: x, y: y, width: bw, height: Math.max(h, 1), rx: Math.min(bw / 2, 4), fill: d.color || opts.color || 'var(--accent)', opacity: d.dim ? .4 : 1 }));
      if (opts.labels) {
        var t = el('text', { x: x + bw / 2, y: H - 5, 'text-anchor': 'middle', fill: 'var(--faint)', 'font-size': 10, 'font-family': 'var(--font-mono)' });
        t.textContent = d.label; svg.appendChild(t);
      }
    });
  }

  /* ---------- sparkline (tiny) ---------- */
  function spark(svg, data, color) {
    var W = svg.viewBox.baseVal.width, H = svg.viewBox.baseVal.height;
    var ex = extent(data), min = ex[0], max = ex[1] === ex[0] ? ex[0] + 1 : ex[1];
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var pts = data.map(function (v, i) { return [(i / (data.length - 1)) * W, 2 + (1 - (v - min) / (max - min)) * (H - 4)]; });
    svg.appendChild(el('path', { d: smoothPath(pts), fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round', opacity: .85 }));
  }

  /* ---------- ring progress ---------- */
  function setRing(circle, pct) {
    var r = circle.r.baseVal.value;
    var c = 2 * Math.PI * r;
    circle.style.strokeDasharray = c;
    circle.style.strokeDashoffset = c * (1 - Math.max(0, Math.min(1, pct)));
  }

  /* ---------- expose + auto-init ---------- */
  window.OF = {
    lineChart: lineChart, multiChart: multiChart, barChart: barChart,
    spark: spark, setRing: setRing, el: el, smoothPath: smoothPath, extent: extent,
    // deterministic pseudo-random walk for demo series (stable per seed)
    walk: function (n, seed, base, amp, drift) {
      var out = [], v = base, s = seed || 1;
      for (var i = 0; i < n; i++) {
        s = (s * 9301 + 49297) % 233280;
        var rnd = s / 233280;
        v += (rnd - 0.5) * amp + (drift || 0);
        out.push(v);
      }
      return out;
    }
  };

  document.addEventListener('DOMContentLoaded', function () {
    initDrawer(); initSegs();
    // auto-draw rings flagged data-ring
    document.querySelectorAll('[data-ring]').forEach(function (c) {
      requestAnimationFrame(function () { setRing(c, parseFloat(c.dataset.ring)); });
    });
  });
})();
