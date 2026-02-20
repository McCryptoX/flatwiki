(function(){
  // If the server already set data-theme (logged-in user), honour it
  // but still sync localStorage so the toggle works offline/after logout
  var serverTheme = document.documentElement.getAttribute("data-theme");
  if (serverTheme === "light" || serverTheme === "dark") {
    localStorage.setItem("fw-theme", serverTheme);
    return;
  }
  // Guest / system preference: fall back to localStorage then prefers-color-scheme
  var t = localStorage.getItem("fw-theme");
  if (t === "dark" || t === "light") {
    document.documentElement.setAttribute("data-theme", t);
  } else if (matchMedia("(prefers-color-scheme:dark)").matches) {
    document.documentElement.setAttribute("data-theme", "dark");
  }
})()
