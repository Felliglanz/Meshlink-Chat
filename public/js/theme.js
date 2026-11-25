/* MeshLink Chat – Farbschema vor dem ersten Zeichnen setzen (kein Modul, damit es sofort läuft und nichts aufblitzt). */
(function () {
  var t = null;
  try { t = JSON.parse(localStorage.getItem('mc.theme') || 'null'); } catch (e) { /* egal */ }
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
}());
