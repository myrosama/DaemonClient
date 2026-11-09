// Derived from filebrowser/filebrowser@e8a388f (Apache-2.0). Modified by DaemonClient contributors.
function loading(button: string) {
  const el: HTMLButtonElement | null = document.querySelector(
    `#${button}-button > i`
  );

  if (el === undefined || el === null) {
    console.log("Error getting button " + button);
    return;
  }

  if (el.innerHTML == "autorenew" || el.innerHTML == "done") {
    return;
  }

  el.dataset.icon = el.innerHTML;
  el.style.opacity = "0";

  setTimeout(() => {
    if (el) {
      el.classList.add("spin");
      el.textContent = "autorenew";
      el.style.opacity = "1";
    }
  }, 100);
}

function done(button: string) {
  const el: HTMLButtonElement | null = document.querySelector(
    `#${button}-button > i`
  );

  if (el === undefined || el === null) {
    console.log("Error getting button " + button);
    return;
  }

  el.style.opacity = "0";

  setTimeout(() => {
    if (el !== null) {
      el.classList.remove("spin");
      el.textContent = el?.dataset?.icon || "";
      el.style.opacity = "1";
    }
  }, 100);
}

function success(button: string) {
  const el: HTMLButtonElement | null = document.querySelector(
    `#${button}-button > i`
  );

  if (el === undefined || el === null) {
    console.log("Error getting button " + button);
    return;
  }

  el.style.opacity = "0";

  setTimeout(() => {
    if (el !== null) {
      el.classList.remove("spin");
      el.textContent = "done";
      el.style.opacity = "1";
    }
    setTimeout(() => {
      if (el) el.style.opacity = "0";

      setTimeout(() => {
        if (el !== null) {
          el.textContent = el?.dataset?.icon || "";
          el.style.opacity = "1";
        }
      }, 100);
    }, 500);
  }, 100);
}

export default {
  loading,
  done,
  success,
};
