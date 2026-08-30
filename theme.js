(() => {
    "use strict";

    const key = "cataclysm-theme";
    const saved = localStorage.getItem(key) || "device";

    function applyTheme(choice) {
        const resolved = choice === "device"
            ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
            : choice;

        document.documentElement.dataset.theme = resolved;
        document.documentElement.dataset.themeChoice = choice;
    }

    window.CataclysmTheme = {
        choice: saved,
        set(choice) {
            const valid = ["light", "dark", "device"];
            const next = valid.includes(choice) ? choice : "device";
            localStorage.setItem(key, next);
            this.choice = next;
            applyTheme(next);
        }
    };

    applyTheme(saved);

    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
        if ((localStorage.getItem(key) || "device") === "device") {
            applyTheme("device");
        }
    });
})();
