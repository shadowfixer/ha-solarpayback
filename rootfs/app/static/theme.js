// HA SunBack theme.js — Light/dark theme handler
// Loads in <head> before page draws, so there's no flash of wrong theme.

(function() {
  "use strict";

  var KEY = "ha-sunback-theme";

  function saved() {
    try {
      var t = localStorage.getItem(KEY);
      return (t === "light" || t === "dark") ? t : "system";
    } catch (e) {
      return "system";
    }
  }

  function isDark() {
    var t = saved();
    return t === "dark" || (t === "system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  function apply() {
    var t = saved();
    var html = document.documentElement;

    if (t === "system") {
      html.removeAttribute("data-theme");
    } else {
      html.setAttribute("data-theme", t);
    }

    // Update theme-color meta for mobile browser chrome
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute("content", isDark() ? "#12151B" : "#1C2B4A");
    }

    // Update theme button icons if present
    var btn = document.getElementById("themeBtn");
    if (btn) {
      var dark = isDark();
      btn.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
      btn.setAttribute("aria-pressed", dark ? "true" : "false");
      var sun = btn.querySelector(".i-sun");
      var moon = btn.querySelector(".i-moon");
      if (sun) sun.style.display = dark ? "none" : "";
      if (moon) moon.style.display = dark ? "" : "none";
    }
  }

  function set(t) {
    try {
      if (t === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, t);
    } catch (e) {}
    apply();
  }

  // Apply immediately (synchronous, before paint)
  apply();

  // Re-apply on DOMContentLoaded and wire up toggle
  document.addEventListener("DOMContentLoaded", function() {
    apply();

    var btn = document.getElementById("themeBtn");
    if (btn) {
      btn.addEventListener("click", function() {
        set(isDark() ? "light" : "dark");
      });
    }

    // Radio buttons in settings (if present)
    document.querySelectorAll('input[name="theme"]').forEach(function(r) {
      r.addEventListener("change", function() {
        if (r.checked) set(r.value);
      });
    });

    // Listen for system preference changes
    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", apply);
    }
  });

  // Export for other modules
  window.HASunBackTheme = { apply, set, isDark, saved };
})();