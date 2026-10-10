/* =============================================================================
   Admin dashboard charts — dependency-free SVG
   Data comes from <script id="dashboard-data">; every chart also has a
   server-rendered table view, so the tooltip never gates a value.
   ============================================================================= */
(function () {
  'use strict';

  var dataEl = document.getElementById('dashboard-data');
  if (!dataEl) return;
  var data = JSON.parse(dataEl.textContent);

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var rootStyle = getComputedStyle(document.documentElement);
  function token(name) { return rootStyle.getPropertyValue(name).trim(); }

  var SERIES = [token('--series-1'), token('--series-2'), token('--series-3')];
  var SURFACE = token('--chart-surface');
  var GRID = token('--chart-grid');
  var AXIS = token('--chart-axis');

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function svgEl(tag, attrs, parent) {
    var node = document.createElementNS(SVG_NS, tag);
    for (var key in attrs) node.setAttribute(key, attrs[key]);
    if (parent) parent.appendChild(node);
    return node;
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function compact(n) {
    return n >= 1000 ? (Math.round(n / 100) / 10) + 'K' : String(n);
  }

  /** Round an axis maximum up to a clean value (at least 4 so small counts get whole ticks). */
  function niceMax(value) {
    if (value <= 4) return 4;
    var magnitude = Math.pow(10, Math.floor(Math.log10(value)));
    var steps = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < steps.length; i++) {
      if (steps[i] * magnitude >= value) return steps[i] * magnitude;
    }
    return 10 * magnitude;
  }

  function sum(values) {
    return values.reduce(function (a, b) { return a + b; }, 0);
  }

  // Shared tooltip
  var tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  tooltip.hidden = true;
  tooltip.setAttribute('role', 'status');
  document.body.appendChild(tooltip);

  function showTooltip(title, rows, clientX, clientY) {
    tooltip.innerHTML = '<div class="tt-title">' + escapeHtml(title) + '</div>' + rows.map(function (row) {
      return '<div class="tt-row"><span class="swatch" style="background:' + row.color + '"></span>' +
        escapeHtml(row.label) + '<strong>' + escapeHtml(row.value) + '</strong></div>';
    }).join('');
    tooltip.hidden = false;
    var pad = 14;
    var rect = tooltip.getBoundingClientRect();
    var x = clientX + pad;
    var y = clientY - rect.height - pad;
    if (x + rect.width > window.innerWidth - 8) x = clientX - rect.width - pad;
    if (y < 8) y = clientY + pad;
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  }

  function hideTooltip() { tooltip.hidden = true; }

  /** Gridlines and y tick labels shared by the cartesian charts. */
  function drawYAxis(svg, geom, yMax) {
    var ticks = 4;
    for (var i = 0; i <= ticks; i++) {
      var value = (yMax / ticks) * i;
      var y = geom.top + geom.plotH - (value / yMax) * geom.plotH;
      svgEl('line', {
        x1: geom.left, x2: geom.left + geom.plotW, y1: y, y2: y,
        stroke: i === 0 ? AXIS : GRID, 'stroke-width': 1, 'shape-rendering': 'crispEdges',
      }, svg);
      var label = svgEl('text', { x: geom.left - 8, y: y + 4, 'text-anchor': 'end', class: 'chart-axis-label' }, svg);
      label.textContent = compact(value % 1 === 0 ? value : Math.round(value * 10) / 10);
    }
  }

  function geometry(container, height) {
    var width = Math.max(container.clientWidth, 280);
    var left = 34, right = 8, top = 10, bottom = 26;
    return { width: width, height: height, left: left, top: top, plotW: width - left - right, plotH: height - top - bottom };
  }

  function emptyState(container, message) {
    container.innerHTML = '<div class="chart-empty">' + escapeHtml(message) + '</div>';
  }

  // ---------------------------------------------------------------------------
  // Line/area chart with crosshair (daily connections + failed sign-ins)
  // ---------------------------------------------------------------------------

  function lineChart(container, labels, series) {
    container.innerHTML = '';
    var all = [].concat.apply([], series.map(function (s) { return s.values; }));
    if (sum(all) === 0) return emptyState(container, 'No sign-in activity in this period');

    var geom = geometry(container, 260);
    var yMax = niceMax(Math.max.apply(null, all));
    var n = labels.length;
    var xAt = function (i) { return geom.left + (n === 1 ? geom.plotW / 2 : (i / (n - 1)) * geom.plotW); };
    var yAt = function (v) { return geom.top + geom.plotH - (v / yMax) * geom.plotH; };

    var svg = svgEl('svg', { viewBox: '0 0 ' + geom.width + ' ' + geom.height, height: geom.height, tabindex: 0 }, container);
    drawYAxis(svg, geom, yMax);

    // Sparse x labels: about six across the axis
    var every = Math.max(1, Math.ceil(n / 6));
    labels.forEach(function (label, i) {
      if (i % every !== 0 && i !== n - 1) return;
      if (i !== n - 1 && n - 1 - i < every / 2) return; // avoid colliding with the last label
      var t = svgEl('text', { x: xAt(i), y: geom.height - 6, 'text-anchor': 'middle', class: 'chart-axis-label' }, svg);
      t.textContent = label;
    });

    // Area wash under the first series only
    var gradId = 'grad-' + container.id;
    var defs = svgEl('defs', {}, svg);
    var grad = svgEl('linearGradient', { id: gradId, x1: 0, x2: 0, y1: 0, y2: 1 }, defs);
    svgEl('stop', { offset: '0%', 'stop-color': series[0].color, 'stop-opacity': 0.22 }, grad);
    svgEl('stop', { offset: '100%', 'stop-color': series[0].color, 'stop-opacity': 0 }, grad);

    var first = series[0].values;
    var areaPath = 'M' + xAt(0) + ',' + yAt(0) + first.map(function (v, i) { return 'L' + xAt(i) + ',' + yAt(v); }).join('') +
      'L' + xAt(n - 1) + ',' + yAt(0) + 'Z';
    svgEl('path', { d: areaPath, fill: 'url(#' + gradId + ')' }, svg);

    // Draw the second series first so the primary line sits on top
    series.slice().reverse().forEach(function (s) {
      var d = s.values.map(function (v, i) { return (i ? 'L' : 'M') + xAt(i) + ',' + yAt(v); }).join('');
      svgEl('path', { d: d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
    });

    // Hover layer: crosshair + ringed markers + tooltip
    var hover = svgEl('g', { visibility: 'hidden' }, svg);
    var crosshair = svgEl('line', { y1: geom.top, y2: geom.top + geom.plotH, stroke: AXIS, 'stroke-width': 1 }, hover);
    var markers = series.map(function (s) {
      return svgEl('circle', { r: 4.5, fill: s.color, stroke: SURFACE, 'stroke-width': 2 }, hover);
    });

    var current = -1;
    function focusIndex(i, clientX, clientY) {
      current = i;
      var x = xAt(i);
      crosshair.setAttribute('x1', x);
      crosshair.setAttribute('x2', x);
      markers.forEach(function (m, si) {
        m.setAttribute('cx', x);
        m.setAttribute('cy', yAt(series[si].values[i]));
      });
      hover.setAttribute('visibility', 'visible');
      if (clientX === undefined) {
        var box = svg.getBoundingClientRect();
        clientX = box.left + (x / geom.width) * box.width;
        clientY = box.top + geom.top;
      }
      showTooltip(labels[i], series.map(function (s) {
        return { color: s.color, label: s.name, value: s.values[i].toLocaleString() };
      }), clientX, clientY);
    }

    function clear() {
      current = -1;
      hover.setAttribute('visibility', 'hidden');
      hideTooltip();
    }

    var hit = svgEl('rect', { x: geom.left, y: geom.top, width: geom.plotW, height: geom.plotH, fill: 'transparent' }, svg);
    hit.addEventListener('pointermove', function (e) {
      var box = svg.getBoundingClientRect();
      var x = ((e.clientX - box.left) / box.width) * geom.width;
      var i = n === 1 ? 0 : Math.round(((x - geom.left) / geom.plotW) * (n - 1));
      focusIndex(Math.min(n - 1, Math.max(0, i)), e.clientX, e.clientY);
    });
    hit.addEventListener('pointerleave', clear);
    svg.addEventListener('blur', clear);
    svg.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      var next = current < 0 ? n - 1 : current + (e.key === 'ArrowRight' ? 1 : -1);
      focusIndex(Math.min(n - 1, Math.max(0, next)));
    });
  }

  // ---------------------------------------------------------------------------
  // Column chart (connections by hour)
  // ---------------------------------------------------------------------------

  function columnChart(container, values, labelFor, color) {
    container.innerHTML = '';
    if (sum(values) === 0) return emptyState(container, 'No connections in this period');

    var geom = geometry(container, 240);
    var yMax = niceMax(Math.max.apply(null, values));
    var n = values.length;
    var band = geom.plotW / n;
    var barW = Math.min(24, band - 2); // 2px surface gap between neighbors, 24px cap
    var radius = Math.min(4, barW / 2);

    var svg = svgEl('svg', { viewBox: '0 0 ' + geom.width + ' ' + geom.height, height: geom.height, tabindex: 0 }, container);
    drawYAxis(svg, geom, yMax);

    var bars = [];
    values.forEach(function (v, i) {
      var cx = geom.left + band * i + band / 2;
      if (i % 3 === 0) {
        var t = svgEl('text', { x: cx, y: geom.height - 6, 'text-anchor': 'middle', class: 'chart-axis-label' }, svg);
        t.textContent = String(i).padStart(2, '0');
      }
      var h = (v / yMax) * geom.plotH;
      var bar = null;
      if (v > 0) {
        var x0 = cx - barW / 2, x1 = cx + barW / 2;
        var yBase = geom.top + geom.plotH, yTop = yBase - h;
        var r = Math.min(radius, h);
        // Rounded data-end, square at the baseline
        var d = 'M' + x0 + ',' + yBase + 'V' + (yTop + r) + 'Q' + x0 + ',' + yTop + ' ' + (x0 + r) + ',' + yTop +
          'H' + (x1 - r) + 'Q' + x1 + ',' + yTop + ' ' + x1 + ',' + (yTop + r) + 'V' + yBase + 'Z';
        bar = svgEl('path', { d: d, fill: color }, svg);
      }
      bars.push(bar);
    });

    var current = -1;
    function focusIndex(i, clientX, clientY) {
      current = i;
      bars.forEach(function (b, bi) { if (b) b.setAttribute('opacity', bi === i ? 1 : 0.45); });
      if (clientX === undefined) {
        var box = svg.getBoundingClientRect();
        clientX = box.left + ((geom.left + band * i + band / 2) / geom.width) * box.width;
        clientY = box.top + geom.top;
      }
      showTooltip(labelFor(i), [{ color: color, label: 'Connections', value: values[i].toLocaleString() }], clientX, clientY);
    }
    function clear() {
      current = -1;
      bars.forEach(function (b) { if (b) b.setAttribute('opacity', 1); });
      hideTooltip();
    }

    // Hit targets span the whole band, much larger than the bar itself
    values.forEach(function (v, i) {
      var hit = svgEl('rect', { x: geom.left + band * i, y: geom.top, width: band, height: geom.plotH, fill: 'transparent' }, svg);
      hit.addEventListener('pointermove', function (e) { focusIndex(i, e.clientX, e.clientY); });
      hit.addEventListener('pointerleave', clear);
    });
    svg.addEventListener('blur', clear);
    svg.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      var next = current < 0 ? 0 : current + (e.key === 'ArrowRight' ? 1 : -1);
      focusIndex(Math.min(n - 1, Math.max(0, next)));
    });
  }

  // ---------------------------------------------------------------------------
  // Donut (sign-in method share)
  // ---------------------------------------------------------------------------

  function donutChart(container, items) {
    container.innerHTML = '';
    var total = sum(items.map(function (it) { return it.value; }));
    if (total === 0) return;

    var size = 168, r = 70, thickness = 18;
    var c = size / 2;
    var svg = svgEl('svg', { viewBox: '0 0 ' + size + ' ' + size, height: size }, container);

    var angle = -Math.PI / 2;
    items.forEach(function (it, i) {
      var sweep = (it.value / total) * Math.PI * 2;
      var a0 = angle, a1 = angle + sweep;
      angle = a1;
      var large = sweep > Math.PI ? 1 : 0;
      var p = function (a) { return (c + r * Math.cos(a)) + ',' + (c + r * Math.sin(a)); };
      // Arc stroke; the 2px surface-colored caps between segments come from the outer path below
      var seg = svgEl('path', {
        d: 'M' + p(a0) + 'A' + r + ',' + r + ' 0 ' + large + ' 1 ' + p(a1),
        fill: 'none', stroke: SERIES[i], 'stroke-width': thickness,
      }, svg);
      seg.addEventListener('pointermove', function (e) {
        showTooltip(it.label, [{ color: SERIES[i], label: 'Connections', value: it.value + ' (' + Math.round((it.value / total) * 100) + '%)' }], e.clientX, e.clientY);
      });
      seg.addEventListener('pointerleave', hideTooltip);
    });

    // 2px surface gaps at each segment boundary
    angle = -Math.PI / 2;
    items.forEach(function (it) {
      var a = angle;
      angle += (it.value / total) * Math.PI * 2;
      svgEl('line', {
        x1: c + (r - thickness / 2 - 1) * Math.cos(a), y1: c + (r - thickness / 2 - 1) * Math.sin(a),
        x2: c + (r + thickness / 2 + 1) * Math.cos(a), y2: c + (r + thickness / 2 + 1) * Math.sin(a),
        stroke: SURFACE, 'stroke-width': 2, 'pointer-events': 'none',
      }, svg);
    });

    var value = svgEl('text', { x: c, y: c + 2, 'text-anchor': 'middle', fill: token('--text'), 'font-size': 26, 'font-weight': 700 }, svg);
    value.textContent = compact(total);
    var caption = svgEl('text', { x: c, y: c + 20, 'text-anchor': 'middle', class: 'chart-axis-label' }, svg);
    caption.textContent = 'sign-ins';
  }

  // ---------------------------------------------------------------------------
  // Render + re-render on resize
  // ---------------------------------------------------------------------------

  function pad2(h) { return String(h % 24).padStart(2, '0') + ':00'; }

  function renderAll() {
    hideTooltip();
    var daily = document.getElementById('chart-daily');
    if (daily) {
      lineChart(daily, data.daily.labels, [
        { name: 'Connections', values: data.daily.connections, color: SERIES[0] },
        { name: 'Failed sign-ins', values: data.daily.failed, color: SERIES[1] },
      ]);
    }
    var hourly = document.getElementById('chart-hourly');
    if (hourly) {
      columnChart(hourly, data.hourly, function (h) { return pad2(h) + '–' + pad2(h + 1); }, SERIES[0]);
    }
    var auth = document.getElementById('chart-auth');
    if (auth) donutChart(auth, data.authMethods);
  }

  renderAll();

  var resizeTimer = null;
  var lastWidth = window.innerWidth;
  window.addEventListener('resize', function () {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderAll, 150);
  });
})();
