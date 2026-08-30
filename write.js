const form = document.getElementById("articleForm");

form.addEventListener("submit", async function (event) {

    event.preventDefault();

    const headline =
        document.getElementById("headline").value.trim();

    const body =
        document.getElementById("body").value.trim();


    if (!headline || !body) {

        alert("Please fill in the headline and article.");

        return;
    }


    try {

        const response = await fetch("/api/articles", {

            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({
                headline,
                body
            })

        });


        const data = await response.json();


        if (!response.ok) {

            alert(data.error);

            return;
        }


        alert(
            "Article submitted successfully! It is now waiting for admin approval."
        );


        window.location.href = "index.html";


    } catch (error) {

        console.error(error);

        alert("Could not connect to the server.");

    }

});