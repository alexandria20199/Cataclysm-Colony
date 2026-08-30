const form = document.getElementById("loginForm");

form.addEventListener("submit", async function (event) {
    event.preventDefault();

    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;

    try {
        const response = await fetch("/api/login", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                username,
                password
            })
        });

        const data = await response.json();

        if (!response.ok) {
            alert(data.error);
            return;
        }

        alert("Login successful!");

        window.location.href = "index.html";

    } catch (error) {
        console.error(error);
        alert("Could not connect to the server.");
    }
});