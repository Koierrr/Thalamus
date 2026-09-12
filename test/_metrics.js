(function () {
  var q = function (s) { return document.querySelector(s); };
  var qa = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var cs = function (el) { return el ? getComputedStyle(el) : null; };
  var W = function (el) { return el ? Math.round(el.getBoundingClientRect().width) : null; };
  var H = function (el) { return el ? Math.round(el.getBoundingClientRect().height) : null; };
  var body = cs(document.body);
  var sec = q('details.sec>summary'), item = q('details.item>summary'), lab = q('.f>label');
  var labels = qa('.f>label');
  var wrapped = labels.filter(function (l) { return l.getBoundingClientRect().height > 46; });
  var fs = qa('.f');
  var byParent = {};
  fs.forEach(function (el) {
    var cls = (el.parentElement && el.parentElement.className || 'none').split(' ')[0];
    byParent[cls] = (byParent[cls] || 0) + 1;
  });
  var rows = {};
  fs.forEach(function (el) { var t = Math.round(el.getBoundingClientRect().top); rows[t] = (rows[t] || 0) + 1; });
  var perRow = Object.keys(rows).map(function (k) { return rows[k]; });
  var diag = fs.slice(0, 6).map(function (el) {
    var p = el.parentElement; var pcs = p ? getComputedStyle(p) : null;
    return (el.className || 'f') + '>gc=' + cs(el).gridColumnEnd + ',w=' + W(el) + '@' + ((p && p.className) || '') + ':' + (pcs ? pcs.display + '[' + pcs.gridTemplateColumns + ']' : '');
  });
  var wide = qa('main *').filter(function (e) { return e.getBoundingClientRect().width > window.innerWidth + 2; });
  var inputs = qa('.f>input:not([type=range]):not([type=checkbox])').map(function (i) { return Math.round(i.getBoundingClientRect().width); });
  var secs = qa('details.sec').map(function (s) { var t = s.querySelector('summary>span'); return (t ? t.textContent : '') + (s.open ? '开' : '收'); });
  return [
    'font=' + body.fontSize,
    'secFont=' + (sec ? cs(sec).fontSize : '-'),
    'itemFont=' + (item ? cs(item).fontSize : '-'),
    'labelStyle=' + (lab ? cs(lab).fontSize + '/' + W(lab) : '-'),
    'inputs=' + (inputs.length ? Math.min.apply(null, inputs) + '~' + Math.max.apply(null, inputs) : '-'),
    'fields=' + fs.length,
    'byParent=' + JSON.stringify(byParent),
    'perRow=' + JSON.stringify(perRow.sort(function (a, b) { return b - a; }).slice(0, 6)),
    'labelWrap=' + wrapped.length + (wrapped.length ? '(' + wrapped.slice(0, 3).map(function (l) { return l.textContent.slice(0, 12) + '=' + H(l); }).join(',') + ')' : ''),
    'diag=' + JSON.stringify(diag),
    'overflow=' + wide.length,
    'scrollW=' + document.documentElement.scrollWidth + '/' + window.innerWidth,
    'sections=' + secs.length + (secs.length ? '[' + secs.join(' ') + ']' : ''),
    'items=' + qa('details.item').length,
    'mainH=' + H(q('main'))
  ].join(' | ');
})()
