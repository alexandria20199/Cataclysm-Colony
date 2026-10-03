// ============================================================
// Cataclysm Colony
// PROFILE PAGE
// ============================================================


// ============================================================
// URL / PROFILE TARGET
// ============================================================

const params = new URLSearchParams(
    window.location.search
);

const profileUsername =
    params.get("username") ||
    params.get("user");


// ============================================================
// ELEMENTS
// ============================================================

const usernameElement =
    document.getElementById(
        "profileUsername"
    );

const bioElement =
    document.getElementById(
        "profileBio"
    );

const profilePicture =
    document.getElementById(
        "profilePicture"
    );

const profilePlaceholder =
    document.getElementById(
        "profilePlaceholder"
    );

const followerCount =
    document.getElementById(
        "followerCount"
    );

const followingCount =
    document.getElementById(
        "followingCount"
    );

const articleCount =
    document.getElementById(
        "articleCount"
    );

const followButton =
    document.getElementById(
        "followButton"
    );

const profileMessage =
    document.getElementById(
        "profileMessage"
    );

const articleList =
    document.getElementById(
        "articleList"
    );

const editProfileButton = document.getElementById("editProfileButton");
const profileEditor = document.getElementById("profileEditor");
const profileEditForm = document.getElementById("profileEditForm");
const profilePictureInput = document.getElementById("profilePictureInput");
const profileBioInput = document.getElementById("profileBioInput");
const bioCharacterCount = document.getElementById("bioCharacterCount");
const cancelProfileEdit = document.getElementById("cancelProfileEdit");
const removeProfilePicture = document.getElementById("removeProfilePicture");

const accountArea =
    document.getElementById(
        "accountArea"
    );


// ============================================================
// STATE
// ============================================================

let currentProfile = null;
let currentUser = null;
let followRequestInProgress = false;
let pendingProfilePicture = null;


// ============================================================
// ESCAPE HTML
// ============================================================

function escapeHTML(value) {

    if (
        value === null ||
        value === undefined
    ) {
        return "";
    }

    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}


// ============================================================
// NUMBER FORMAT
// ============================================================

function formatNumber(value) {

    const number =
        Number(value) || 0;

    return number.toLocaleString();
}


// ============================================================
// DATE FORMAT
// ============================================================

function formatDate(value) {

    if (!value) {
        return "";
    }

    const normalized =
        String(value).replace(" ", "T");

    let date =
        new Date(normalized);

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        date =
            new Date(
                `${normalized}Z`
            );
    }

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        return "";
    }

    return date.toLocaleDateString(
        undefined,
        {
            year: "numeric",
            month: "long",
            day: "numeric"
        }
    );
}


// ============================================================
// INITIAL
// ============================================================

function getInitial(username) {

    if (
        !username ||
        !String(username).trim()
    ) {
        return "?";
    }

    return String(username)
        .trim()
        .charAt(0)
        .toUpperCase();
}


// ============================================================
// API JSON HELPER
// ============================================================

async function fetchJSON(
    url,
    options = {}
) {

    const response =
        await fetch(
            url,
            {
                credentials: "same-origin",
                ...options
            }
        );

    let data = null;

    try {

        data =
            await response.json();

    } catch {

        data = null;

    }

    if (!response.ok) {

        const error =
            new Error(
                data?.error ||
                "Request failed."
            );

        error.status =
            response.status;

        error.data =
            data;

        throw error;
    }

    return data;
}


// ============================================================
// ACCOUNT
// ============================================================

async function loadAccount() {

    if (!accountArea) {
        return;
    }

    try {

        const user =
            await fetchJSON(
                "/api/me"
            );

        currentUser =
            user;


        const verified =
            user.is_verified
                ? "✔ "
                : "";


        accountArea.innerHTML = `

            <a
                href="profile.html?username=${encodeURIComponent(
                    user.username
                )}"
                class="account-user"
            >
                ${verified}${escapeHTML(
                    user.username
                )}
            </a>

            <button
                type="button"
                class="header-logout"
                id="logoutButton"
            >
                Log out
            </button>

        `;


        const logoutButton =
            document.getElementById(
                "logoutButton"
            );


        if (logoutButton) {

            logoutButton.addEventListener(
                "click",
                logout
            );

        }

    } catch {

        currentUser =
            null;

        accountArea.innerHTML = `

            <a
                href="login.html"
                class="header-login"
            >
                Log in
            </a>

            <a
                href="register.html"
                class="header-register"
            >
                Join
            </a>

        `;
    }
}


// ============================================================
// LOGOUT
// ============================================================

async function logout() {

    try {

        await fetch(
            "/api/logout",
            {
                method: "POST",
                credentials: "same-origin"
            }
        );

    } catch (error) {

        console.error(
            "LOGOUT ERROR:",
            error
        );

    }

    window.location.href =
        "index.html";
}


// ============================================================
// PROFILE PICTURE
// ============================================================

function loadProfilePicture(
    profile
) {

    if (
        !profilePicture ||
        !profilePlaceholder
    ) {
        return;
    }


    const picture =
        profile.profile_picture;


    if (
        picture &&
        String(picture).trim()
    ) {

        profilePicture.src =
            picture;

        profilePicture.alt =
            `${profile.username}'s profile picture`;

        profilePicture.style.display =
            "block";

        profilePlaceholder.style.display =
            "none";


        profilePicture.onerror =
            function () {

                profilePicture.style.display =
                    "none";

                profilePlaceholder.style.display =
                    "flex";

                profilePlaceholder.textContent =
                    getInitial(
                        profile.username
                    );

            };


    } else {

        profilePicture.removeAttribute(
            "src"
        );

        profilePicture.style.display =
            "none";

        profilePlaceholder.style.display =
            "flex";

        profilePlaceholder.textContent =
            getInitial(
                profile.username
            );
    }
}


// ============================================================
// PROFILE HERO
// ============================================================

function renderProfile(
    profile
) {

    if (!profile) {
        return;
    }


    const username =
        profile.username ||
        "Unknown";


    if (usernameElement) {

        usernameElement.textContent =
            `@${username}`;

    }


    if (bioElement) {

        const bio =
            typeof profile.bio === "string"
                ? profile.bio.trim()
                : "";

        bioElement.textContent =
            bio ||
            "No bio yet.";

    }


    if (followerCount) {

        followerCount.textContent =
            formatNumber(
                profile.follower_count
            );

    }


    if (followingCount) {

        followingCount.textContent =
            formatNumber(
                profile.following_count
            );

    }


    if (articleCount) {

        articleCount.textContent =
            formatNumber(
                profile.article_count
            );

    }


    loadProfilePicture(
        profile
    );


    document.title =
        `@${username} — Cataclysm Colony`;
}


// ============================================================
// OWN PROFILE EDITOR
// ============================================================

function isOwnProfile() {

    return Boolean(
        currentUser &&
        currentProfile &&
        Number(currentUser.id) === Number(currentProfile.id)
    );
}


function isOwner() {

    return currentUser?.role === "owner";
}


function updateProfileEditorAccess() {

    if (!editProfileButton) {
        return;
    }

    editProfileButton.style.display =
        isOwnProfile() ? "inline-flex" : "none";

    if (!isOwnProfile() && profileEditor) {
        profileEditor.hidden = true;
    }
}


function updateBioCount() {

    if (bioCharacterCount && profileBioInput) {
        bioCharacterCount.textContent = profileBioInput.value.length;
    }
}


function openProfileEditor() {

    if (!isOwnProfile() || !profileEditor) {
        return;
    }

    pendingProfilePicture = currentProfile.profile_picture || "";

    if (profileBioInput) {
        profileBioInput.value = currentProfile.bio || "";
    }

    if (profilePictureInput) {
        profilePictureInput.value = "";
    }

    updateBioCount();
    profileEditor.hidden = false;
    profileBioInput?.focus();
}


function closeProfileEditor() {

    if (profileEditor) {
        profileEditor.hidden = true;
    }

    pendingProfilePicture = null;
}


async function readProfilePicture(file) {

    if (!file) {
        return;
    }

    if (!file.type.startsWith("image/")) {
        showMessage("Choose an image file for your profile picture.");
        return;
    }

    if (file.size > 1.5 * 1024 * 1024) {
        showMessage("Profile pictures must be 1.5 MB or smaller.");
        return;
    }

    pendingProfilePicture = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Could not read that image."));
        reader.readAsDataURL(file);
    });

    loadProfilePicture({
        ...currentProfile,
        profile_picture: pendingProfilePicture
    });
}


async function saveProfile(event) {

    event.preventDefault();

    if (!isOwnProfile()) {
        return;
    }

    const saveButton = profileEditForm?.querySelector("button[type='submit']");

    if (saveButton) {
        saveButton.disabled = true;
        saveButton.textContent = "Saving...";
    }

    try {

        await fetchJSON("/api/me", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                bio: profileBioInput?.value || "",
                profile_picture: pendingProfilePicture || ""
            })
        });

        const updatedUser = await fetchJSON("/api/me");

        currentUser = updatedUser;
        currentProfile = {
            ...currentProfile,
            bio: updatedUser.bio,
            profile_picture: updatedUser.profile_picture
        };

        renderProfile(currentProfile);
        closeProfileEditor();
        showMessage("Your profile has been updated.");

    } catch (error) {

        console.error("PROFILE SAVE ERROR:", error);
        showMessage(error.message || "Could not update your profile.");

    } finally {

        if (saveButton) {
            saveButton.disabled = false;
            saveButton.textContent = "Save profile";
        }
    }
}


// ============================================================
// FOLLOW BUTTON
// ============================================================

function setupFollowButton() {

    if (!followButton) {
        return;
    }


    followButton.onclick =
        handleFollow;


    updateFollowButton();
}


// ============================================================
// UPDATE FOLLOW BUTTON
// ============================================================

function updateFollowButton() {

    if (
        !followButton ||
        !currentProfile
    ) {
        return;
    }


    // Not logged in.

    if (!currentUser) {

        followButton.style.display =
            "none";

        return;
    }


    // Own profile.

    const isOwnProfile =
        Number(currentUser.id) ===
        Number(currentProfile.id);


    if (isOwnProfile) {

        followButton.style.display =
            "none";

        return;
    }


    // Other user's profile.

    followButton.style.display =
        "inline-block";


    const following =
        Boolean(
            currentProfile.is_following
        );


    followButton.textContent =
        following
            ? "Following"
            : "Follow";


    followButton.classList.toggle(
        "following",
        following
    );


    followButton.disabled =
        followRequestInProgress;
}


// ============================================================
// FOLLOW / UNFOLLOW
// ============================================================

async function handleFollow() {

    if (
        !currentProfile ||
        followRequestInProgress
    ) {
        return;
    }


    if (!currentUser) {

        showMessage(
            "Log in to follow users."
        );

        return;
    }


    if (
        Number(currentUser.id) ===
        Number(currentProfile.id)
    ) {
        return;
    }


    const currentlyFollowing =
        Boolean(
            currentProfile.is_following
        );


    followRequestInProgress =
        true;


    followButton.disabled =
        true;


    followButton.textContent =
        currentlyFollowing
            ? "Unfollowing..."
            : "Following...";


    try {

        const data =
            await fetchJSON(
                `/api/follow/${encodeURIComponent(
                    currentProfile.username
                )}`,
                {
                    method:
                        currentlyFollowing
                            ? "DELETE"
                            : "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    }
                }
            );


        currentProfile.is_following =
            Boolean(
                data.is_following
            );


        if (
            data.follower_count !==
            undefined
        ) {

            currentProfile.follower_count =
                data.follower_count;

        }


        if (followerCount) {

            followerCount.textContent =
                formatNumber(
                    currentProfile.follower_count
                );

        }


        updateFollowButton();


        showMessage(
            data.message ||
            (
                currentProfile.is_following
                    ? "You are now following this user."
                    : "You unfollowed this user."
            )
        );


    } catch (error) {

        console.error(
            "FOLLOW ERROR:",
            error
        );


        updateFollowButton();


        showMessage(
            error.message ||
            "Could not update follow status."
        );


    } finally {

        followRequestInProgress =
            false;

        updateFollowButton();

    }
}


// ============================================================
// MESSAGE
// ============================================================

function showMessage(
    message
) {

    if (!profileMessage) {
        return;
    }


    profileMessage.textContent =
        message || "";


    clearTimeout(
        showMessage.timeout
    );


    if (!message) {
        return;
    }


    showMessage.timeout =
        setTimeout(
            function () {

                profileMessage.textContent =
                    "";

            },
            3500
        );
}


// ============================================================
// ARTICLE IMAGE
// ============================================================

function createArticleImage(
    article
) {

    if (
        !article ||
        !article.image
    ) {
        return null;
    }


    const image =
        document.createElement(
            "img"
        );


    image.className =
        "profile-article-image";


    image.src =
        article.image;


    image.alt =
        article.headline ||
        "Article image";


    image.loading =
        "lazy";


    image.onerror =
        function () {

            image.remove();

        };


    return image;
}


// ============================================================
// ARTICLES
// ============================================================

function renderArticles(
    articles
) {

    if (!articleList) {
        return;
    }


    if (
        !Array.isArray(articles) ||
        articles.length === 0
    ) {

        articleList.innerHTML = `

            <div class="profile-article">

                <h3>
                    No published articles yet.
                </h3>

                <p>
                    This contributor hasn't published
                    anything yet.
                </p>

            </div>

        `;

        return;
    }


    articleList.innerHTML =
        "";


    articles.forEach(
        function (article) {

            const articleElement =
                document.createElement(
                    "article"
                );


            articleElement.className =
                "profile-article";


            // ----------------------------------------------
            // IMAGE
            // ----------------------------------------------

            const image =
                createArticleImage(
                    article
                );


            if (image) {

                articleElement.appendChild(
                    image
                );

            }


            // ----------------------------------------------
            // CATEGORY
            // ----------------------------------------------

            const category =
                document.createElement(
                    "span"
                );


            category.className =
                "profile-article-category";


            category.textContent =
                article.category ||
                "NEWS";


            articleElement.appendChild(
                category
            );


            // ----------------------------------------------
            // HEADLINE
            // ----------------------------------------------

            const headline =
                document.createElement(
                    "h3"
                );


            const link =
                document.createElement(
                    "a"
                );


            link.href =
                `article.html?id=${encodeURIComponent(
                    article.id
                )}`;


            link.textContent =
                article.headline ||
                "Untitled article";


            headline.appendChild(
                link
            );


            articleElement.appendChild(
                headline
            );


            // ----------------------------------------------
            // SUMMARY
            // ----------------------------------------------

            if (article.summary) {

                const summary =
                    document.createElement(
                        "p"
                    );


                summary.textContent =
                    article.summary;


                articleElement.appendChild(
                    summary
                );

            }


            // ----------------------------------------------
            // META
            // ----------------------------------------------

            const meta =
                document.createElement(
                    "small"
                );


            const date =
                article.published_at ||
                article.created_at;


            meta.textContent =
                date
                    ? `Published ${formatDate(
                        date
                    )}`
                    : "Published recently";


            articleElement.appendChild(
                meta
            );

            const canEditArticle =
                isOwnProfile() ||
                currentUser?.role === "admin" ||
                currentUser?.role === "owner";

            if (canEditArticle) {

                const editLink =
                    document.createElement("a");

                editLink.className =
                    "profile-edit-article";

                editLink.href =
                    `write.html?edit=${encodeURIComponent(
                        article.id
                    )}`;

                editLink.textContent =
                    currentUser?.role === "owner"
                        ? "Edit and publish"
                        : "Request edit";

                articleElement.appendChild(editLink);
            }

            if (isOwnProfile() || isOwner()) {

                const deleteButton =
                    document.createElement("button");

                deleteButton.type = "button";
                deleteButton.className = "profile-delete-article";
                deleteButton.textContent =
                    isOwnProfile()
                        ? "Delete article"
                        : "Owner delete";
                deleteButton.addEventListener("click", function () {
                    deletePublishedArticle(article, deleteButton);
                });

                articleElement.appendChild(deleteButton);
            }


            articleList.appendChild(
                articleElement
            );

        }
    );
}


async function deletePublishedArticle(article, button) {

    const title = article?.headline || "this article";
    const ownArticle = isOwnProfile();

    if (!confirm(`Delete "${title}"? This permanently removes the article and its comments.`)) {
        return;
    }

    button.disabled = true;
    button.textContent = "Deleting...";

    try {

        const data = await fetchJSON(
            ownArticle
                ? `/api/my-articles/${encodeURIComponent(article.id)}`
                : `/api/admin/articles/${encodeURIComponent(article.id)}`,
            { method: "DELETE" }
        );

        currentProfile.articles = (currentProfile.articles || []).filter(
            item => Number(item.id) !== Number(article.id)
        );
        currentProfile.article_count = currentProfile.articles.length;

        renderProfile(currentProfile);
        renderArticles(currentProfile.articles);
        showMessage(data.message || "Article deleted.");

    } catch (error) {

        console.error("ARTICLE DELETE ERROR:", error);
        button.disabled = false;
        button.textContent = "Delete article";
        showMessage(error.message || "Could not delete this article.");
    }
}


// ============================================================
// PROFILE ERROR
// ============================================================

function showProfileError(
    title,
    message
) {

    if (usernameElement) {

        usernameElement.textContent =
            title ||
            "Profile unavailable";

    }


    if (bioElement) {

        bioElement.textContent =
            message ||
            "This profile could not be loaded.";

    }


    if (followerCount) {
        followerCount.textContent = "0";
    }


    if (followingCount) {
        followingCount.textContent = "0";
    }


    if (articleCount) {
        articleCount.textContent = "0";
    }


    if (followButton) {

        followButton.style.display =
            "none";

    }


    if (profilePicture) {

        profilePicture.style.display =
            "none";

    }


    if (profilePlaceholder) {

        profilePlaceholder.style.display =
            "flex";

        profilePlaceholder.textContent =
            "!";

    }


    if (articleList) {

        articleList.innerHTML = `

            <div class="profile-article">

                <h3>
                    Profile unavailable
                </h3>

                <p>
                    ${escapeHTML(
                        message ||
                        "This profile could not be loaded."
                    )}
                </p>

                <p>
                    <a href="index.html">
                        Return to Cataclysm Colony →
                    </a>
                </p>

            </div>

        `;

    }


    document.title =
        "Profile unavailable — Cataclysm Colony";
}


// ============================================================
// LOAD PROFILE
// ============================================================

async function loadProfile() {

    await loadAccount();

    const targetUsername =
        profileUsername ||
        currentUser?.username;

    if (!targetUsername) {

        showProfileError(
            "Profile not found",
            "No username was provided."
        );

        return;
    }


    try {

        const data =
            await fetchJSON(
                `/api/profile/${encodeURIComponent(
                    targetUsername
                )}`
            );


        currentProfile =
            data;


        renderProfile(
            currentProfile
        );


        setupFollowButton();

        updateProfileEditorAccess();


        renderArticles(
            currentProfile.articles || []
        );


    } catch (error) {

        console.error(
            "PROFILE LOAD ERROR:",
            error
        );


        if (
            error.status === 404
        ) {

            showProfileError(
                "Profile not found",
                error.message ||
                "This profile does not exist."
            );

            return;
        }


        showProfileError(
            "Unable to load profile",
            error.message ||
            "Could not connect to the Cataclysm Colony server."
        );

    }
}


// ============================================================
// START
// ============================================================

editProfileButton?.addEventListener("click", openProfileEditor);
cancelProfileEdit?.addEventListener("click", closeProfileEditor);
profileEditForm?.addEventListener("submit", saveProfile);
profileBioInput?.addEventListener("input", updateBioCount);
profilePictureInput?.addEventListener("change", async function () {
    try {
        await readProfilePicture(this.files?.[0]);
    } catch (error) {
        showMessage(error.message || "Could not use that image.");
    }
});
removeProfilePicture?.addEventListener("click", function () {
    pendingProfilePicture = "";
    profilePictureInput.value = "";
    loadProfilePicture({ ...currentProfile, profile_picture: "" });
});

loadProfile();
