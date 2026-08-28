/**
 * Project Locator GIS Map
 * - Loads project data from a public Google Sheets JSON endpoint
 * - Renders clustered markers with Leaflet + MarkerCluster plugin
 * - Provides search by Project Name and Developer
 * - Opens a modern popup card with project details
 * - Includes loading, error handling, empty state, and reset view
 *
 * No backend, no database, all client-side.
 */

const SHEET_URL =
  "https://opensheet.elk.sh/16aZVmmTBBNTNyoicDNpJRp53Pr5XXIieBw5xP14yYnE/LOCATIONS";

// ------------------------
// DOM references
// ------------------------
const mapEl = document.getElementById("map");
const searchInput = document.getElementById("searchInput");
const searchDropdown = document.getElementById("searchDropdown");
const resetSearchBtn = document.getElementById("resetSearchBtn");
const resetViewBtn = document.getElementById("resetViewBtn");
const markerCountValueEl = document.querySelector("#markerCountPill .pill__value");
const developerSelect = document.getElementById("developerSelect");
const areaSelect = document.getElementById("areaSelect");
const areaFilterBtn = document.getElementById("areaFilterBtn");
const areaFilterPanel = document.getElementById("areaFilterPanel");
const areaFilterCloseBtn = document.getElementById("areaFilterCloseBtn");
const clearAreaFilterBtn = document.getElementById("clearAreaFilterBtn");

const loadingOverlay = document.getElementById("loadingOverlay");
const errorOverlay = document.getElementById("errorOverlay");
const errorMessageEl = document.getElementById("errorMessage");
const retryBtn = document.getElementById("retryBtn");
const emptyOverlay = document.getElementById("emptyOverlay");

// ------------------------
// Card + sidebar UI references
// ------------------------
const desktopCard = document.getElementById("desktopCard");
// Mobile card elements are optional in this UI variant; keep safe null checks.
const mobileCard = document.getElementById("mobileCard");
const mobileCardBody = document.getElementById("mobileCardBody");
const mobileCardCloseBtn = document.getElementById("mobileCardCloseBtn");

const sidebarSearchInput = document.getElementById("sidebarSearchInput");
const sidebarClearBtn = document.getElementById("sidebarClearBtn");
const sidebarList = document.getElementById("sidebarList");

const sidebarDrawer = document.getElementById("sidebarDrawer");
const sidebarDrawerOverlay = document.getElementById("sidebarDrawerOverlay");
const sidebarDrawerCloseBtn = document.getElementById("sidebarDrawerCloseBtn");
const sidebarDrawerSearchInput = document.getElementById("sidebarDrawerSearchInput");
const sidebarDrawerList = document.getElementById("sidebarDrawerList");

const hamburgerBtn = document.getElementById("hamburgerBtn");
const sidebarOverlay = document.getElementById("sidebarOverlay");
const sidebarCloseBtn = document.getElementById("sidebarCloseBtn");
const sidebarEl = document.getElementById("sidebar");
const mobileLayoutMq = window.matchMedia("(max-width: 720px)");

// ------------------------
// Leaflet setup
// ------------------------
/** @type {L.Map | null} */
let map = null;
/** @type {L.MarkerClusterGroup | null} */
let markerCluster = null;
/** @type {L.Marker[]} */
let allMarkers = [];

/** Marker data cache for search */
let projects = []; // normalized project array (ALL loaded projects)
let filteredProjects = []; // currently displayed projects (after filters)
let selectedDeveloper = "__ALL__";
let selectedArea = "__ALL__";

// Sidebar filtering query
let sidebarQuery = "";
let selectedProjectId = null; // sidebar-selected project
let activeProjectId = null; // project whose details card is open

// Track last bounds so "Reset View" can restore
let lastBounds = null;

// ------------------------
// Helpers
// ------------------------
/**
 * Safely converts to number (returns null if invalid).
 * @param {any} v
 * @returns {number | null}
 */
function toNumberOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  return null;
}

/**
 * Normalizes a potentially empty string to a clean string.
 * @param {any} v
 * @returns {string}
 */
function toCleanString(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

/**
 * Returns a safe logo URL/path for both:
 * - External URLs (http/https) -> returned directly
 * - Local asset paths -> returned relative to site root
 *
 * @param {string} value
 * @returns {string}
 */
function getLogoPath(value) {
  // If no logo is provided, use local placeholder.png
  if (!value) return "logo/placeholder.png";


  const path = String(value).trim();

  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }

  return path;
}

/**
 * Light, logo-friendly marker accents.
 * Prefer grays + sky blues so black logos stay readable.
 */
const MARKER_ACCENT_PALETTE = [
  "#13e6e6", // Base orange
  "#13e6e6",
  "#13e6e6",
  "#13e6e6",
  "#13e6e6",
  "#13e6e6",
  "#13e6e6",
  "#13e6e6",
  "#13e6e6",
  "#13e6e6",
  "#13e6e6",
  "#13e6e6"
];

/**
 * Stable hash for picking a marker accent from logo URL or project id.
 * @param {string} value
 * @returns {number}
 */
function hashMarkerKey(value) {
  const s = String(value || "default");
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

/**
 * Returns a visible accent color derived from the project's logo/image.
 * Same logo URL always maps to the same color; different logos get different colors.
 * @param {Project} p
 * @returns {string}
 */
function getMarkerAccentColor(p) {
  const key = p.logoUrl || p.imageUrl || String(p.id || "default");
  const idx = hashMarkerKey(key) % MARKER_ACCENT_PALETTE.length;
  return MARKER_ACCENT_PALETTE[idx];
}


/**
 * Attempts to get a stable status badge class.
 * @param {string} status
 * @returns {string} CSS class
 */
function statusBadgeClass(status) {
  const s = status.trim().toLowerCase();
  if (!s) return "badge--unknown";
  if (s.includes("active") || s.includes("open") || s.includes("live")) return "badge--active";
  if (s.includes("planned") || s.includes("future")) return "badge--planned";
  if (s.includes("inactive") || s.includes("closed") || s.includes("complete") || s.includes("completed"))
    return "badge--unknown";
  return "badge--unknown";
}

/**
 * Returns HTML for popup card (modern real-estate GIS look).
 * Lazy-loads the image.
 *
 * @param {Project} p
 * @returns {string}
 */
function popupCardHTML(p) {
  const DEFAULT_IMG_URL = "logo/placeholder.png";



  // Logo is the visual focus. Supports:
  // - External URLs (http/https) -> used directly
  // - Local asset paths -> used relative to website root
  const logoUrl = p.logoUrl ? String(p.logoUrl) : "";
  const safeLogo = logoUrl ? getLogoPath(logoUrl) : DEFAULT_IMG_URL;


  const clientName = p.clientName || "—";
  const projectName = p.projectName || "—";
  const address = p.address || "—";
  // New sheet column: Link
  const mapsLink = p.mapsLink ? String(p.mapsLink).trim() : "";

  const mapsCTA = mapsLink
    ? `
      <a
        class="mapsCtaBtn"
        href="${escapeHtml(mapsLink)}"
        target="_blank"
        rel="noopener noreferrer"
      >
        📍 Open in Google Maps
      </a>
    `
    : "";

  return `
    <div class="popup-card cardlike">
      <!-- Close button -->
      <button
        type="button"
        class="cardCloseBtn"
        aria-label="Close project card"
        title="Close"
      >
        ✕
      </button>

      <div class="popup-card__content">
        <img
          class="popup-card__logo"
          src="${safeLogo}"
          alt="${escapeHtml(clientName)}"
          loading="lazy"
          onerror="this.onerror=null;this.src='logo/placeholder.png';"
        />

        <div class="popup-card__client">${escapeHtml(clientName)}</div>
        <div class="popup-card__project">${escapeHtml(projectName)}</div>
        <div class="popup-card__address">${escapeHtml(address)}</div>

        ${mapsCTA}
      </div>
    </div>
  `;
}

/**
 * Escape HTML to prevent injection in popup content.
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/**
 * Builds dropdown entries for search results.
 * @param {Project[]} results
 */
function renderSearchDropdown(results) {
  const items = results.slice(0, 12); // cap results for performance

  if (!items.length) {
    searchDropdown.classList.remove("is-open");
    searchDropdown.innerHTML = "";
    return;
  }

  searchDropdown.innerHTML = items
    .map((p, idx) => {
      const label = p.projectName || "Untitled Project";
      const meta = p.developer ? `by ${p.developer}` : "Developer unknown";
      return `
        <div
          class="search__item"
          role="option"
          tabindex="0"
          data-project-id="${p.id}"
          aria-selected="${idx === 0 ? "true" : "false"}"
        >
          <div class="search__itemTop">
            <div class="search__name">${escapeHtml(label)}</div>
            <div class="search__meta">${escapeHtml(meta)}</div>
          </div>
        </div>
      `;
    })
    .join("");

  searchDropdown.classList.add("is-open");

  // Click/keyboard handlers
  const entries = searchDropdown.querySelectorAll(".search__item");
  entries.forEach((el) => {
    const handler = () => {
      const id = el.getAttribute("data-project-id");
      const p = projects.find((x) => String(x.id) === String(id));
      if (!p) return;

      const marker = p._marker;
      if (!marker) return;

      selectProjectFromList(p);
      closeDropdown();
    };

    el.addEventListener("click", handler);

    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handler();
      }
    });
  });
}

/**
 * Closes dropdown and clears selection state.
 */
function closeDropdown() {
  searchDropdown.classList.remove("is-open");
  searchDropdown.innerHTML = "";
}

/**
 * Opens shared card UI for a project.
 * - Desktop: #desktopCard
 * - Mobile: #mobileCard (bottom sheet)
 * @param {Project} p
 */
function openProjectCard(p) {
  selectedProjectId = p.id;
  activeProjectId = p.id;

  if (!desktopCard) {
    renderSidebarList();
    return;
  }

  // Prepare card
  desktopCard.hidden = false;
  desktopCard.innerHTML = popupCardHTML(p);

  // Bind close button (inside the card)
  const closeBtn = desktopCard.querySelector(".cardCloseBtn");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => closeProjectCard(), { once: true });
  }

  // Fade-only classes (transform offset is handled by JS positioning)
  desktopCard.classList.remove("desktopCard--open", "desktopCard--closing");
  desktopCard.classList.add("desktopCard--preopen");
  void desktopCard.offsetWidth;

  if (!map || !p._marker) {
    try {
      positionDesktopCardBesideMarker(p, { animState: "preopen" });
    } catch {
      // ignore
    }
    requestAnimationFrame(() => {
      desktopCard.classList.remove("desktopCard--preopen");
      desktopCard.classList.add("desktopCard--open");
    });
    renderSidebarList();
    return;
  }

  const markerLatLng = p._marker.getLatLng();
  try {
    map.panTo(markerLatLng, { animate: true, duration: 0.25 });
  } catch {
    map.panTo(markerLatLng, { animate: true });
  }

  // Position immediately (card then follows move/zoom events)
  try {
    positionDesktopCardBesideMarker(p, { animState: "preopen" });
  } catch {
    // ignore
  }

  requestAnimationFrame(() => {
    desktopCard.classList.remove("desktopCard--preopen");
    desktopCard.classList.add("desktopCard--open");
    try {
      positionDesktopCardBesideMarker(p, { animState: "open" });
    } catch {
      // ignore
    }
  });

  if (mobileCard) mobileCard.hidden = true;

  renderSidebarList();

  // Auto-scroll selected item into view (fast + minimal)
  const selectedEl = sidebarList?.querySelector(`.sidebarItem[data-project-id="${CSS.escape(String(selectedProjectId))}"]`);
  selectedEl?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/**
 * Closes shared cards.
 */
function closeProjectCard() {
  const p = getActiveProject() || getCurrentlySelectedProject();
  activeProjectId = null;

  if (desktopCard && !desktopCard.hidden) {
    desktopCard.classList.remove("desktopCard--open");
    desktopCard.classList.add("desktopCard--closing");
    void desktopCard.offsetWidth;

    // Keep last known attached position; animate lift/fade via JS transform offset
    try {
      if (p) positionDesktopCardBesideMarker(p, { animState: "closing" });
    } catch {
      // ignore
    }

    window.setTimeout(() => {
      if (desktopCard) desktopCard.hidden = true;
      desktopCard.classList.remove("desktopCard--preopen");
      desktopCard.classList.remove("desktopCard--closing");
    }, 250);
  }

  if (mobileCard) mobileCard.hidden = true;

  renderSidebarList();
}

// ------------------------
// Data model
// ------------------------
/**
 * @typedef {Object} Project
 * @property {string|number} id
 * @property {string} projectName
 * @property {string} developer
 * @property {number} latitude
 * @property {number} longitude
 * @property {string} area
 * @property {string} description
 * @property {string} imageUrl
 * @property {string} address
 * @property {string} status
 * @property {L.Marker=} _marker
 */

// ------------------------
// Fetch + parse data
// ------------------------
async function fetchProjects() {
  const res = await fetch(SHEET_URL, { method: "GET" });
  if (!res.ok) {
    let bodyPreview = "";
    try {
      bodyPreview = await res.text();
    } catch {
      bodyPreview = "";
    }
    console.error("Projects fetch failed:", {
      url: SHEET_URL,
      status: res.status,
      statusText: res.statusText,
      bodyPreview: bodyPreview?.slice(0, 800)
    });
    throw new Error(`HTTP ${res.status} while loading projects`);
  }

  /** Expected shape: array of objects, keys are column names */
  const data = await res.json();
  if (!Array.isArray(data)) {
    console.error("Unexpected projects payload (not array):", data);
    throw new Error("Unexpected data format from Google Sheets JSON endpoint.");
  }

  // Map sheet columns to the new schema:
  // ID, Logo URL, Client Name, Project Name, Developer, Coordinates, Address
  const normalized = data
    .map((row) => {
      const coords = String(row["Coordinates"] || "");
      const [lat, lng] = coords
        .split(",")
        .map((v) => parseFloat(v.trim()));

      const project = {
        id: row["ID"],
        logoUrl: toCleanString(row["Logo URL"]),
        clientName: toCleanString(row["Client Name"]),
        projectName: toCleanString(row["Project Name"]),
        developer: toCleanString(row["Developer"]),
        area: toCleanString(row["Area"]),
        address: toCleanString(row["Address"]),
        mapsLink: toCleanString(row["Link"]),
        lat,
        lng,

        // Back-compat fields so existing popupCardHTML doesn't crash (no UI changes requested)
        imageUrl: toCleanString(row["Logo URL"]),
        description: "",
        status: ""
      };

      // Validation (skip invalid records)
      if (!project.id || !Number.isFinite(project.lat) || !Number.isFinite(project.lng)) {
        return null;
      }

      console.log("Parsed Project:", project);
      return project;
    })
    .filter(Boolean);

  return normalized;
}

// ------------------------
// Map rendering
// ------------------------
function initMap() {
  // Default view (will be auto-fit after markers are added)
  // Match tile-layer maxZoom (19) so sidebar focus can zoom in tightly.
  map = L.map("map", { zoomControl: true, maxZoom: 19 });

  // Wire card-follow behavior
  // (positioning uses transform; card content is injected on selection)
  wireCardFollowEvents();

  // ------------------------
  // Base layers: OSM + Esri Satellite
  // ------------------------
  const osmLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  });

  // Esri World Imagery tile layer
  const esriSatelliteLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 19,
      attribution:
        '© <a href="https://www.esri.com/en-us/home">Esri</a> &mdash; © ' +
        '<a href="https://www.arcgis.com/home/item.html?id=3d2a7c3e6a7c4bd3a1c0c4e2b3d5a1d0">ArcGIS</a>'
    }
  );

  osmLayer.addTo(map);

  // Layer control (toggle)
  L.control
    .layers(
      {
        "OpenStreetMap": osmLayer,
        "Esri Satellite": esriSatelliteLayer
      },
      null,
      { position: "topright" }
    )
    .addTo(map);

  // ------------------------
  // Marker clustering
  // ------------------------
  markerCluster = L.markerClusterGroup({
    chunkedLoading: true,
    showCoverageOnHover: false,
    disableClusteringAtZoom: 18
  });

  markerCluster.addTo(map);
}

/**
 * Creates markers and attaches popups/cards.
 * Also updates marker count and auto-fit bounds.
 * @param {Project[]} loadedProjects
 */
/**
 * Create a purple “real estate” marker icon.
 * Using divIcon keeps it lightweight and avoids external image dependencies.
 * @param {Project} p
 * @returns {L.DivIcon}
 */
function createPurpleMarkerIcon(p) {
  const DEFAULT_IMG_URL = "logo/placeholder.png";
  const logoUrl = p.logoUrl ? String(p.logoUrl) : "";
  const safeLogo = logoUrl ? getLogoPath(logoUrl) : DEFAULT_IMG_URL;
  const accent = getMarkerAccentColor(p);

  // Rounded rectangle body + centered bottom pointer; tip sits on the coordinate.
  return L.divIcon({
    className: "project-bubble-marker",
    html: `
      <div class="project-bubble-marker__wrap" aria-hidden="true">
        <div class="project-bubble-marker__body" style="--marker-accent: ${accent}">
          <div class="project-bubble-marker__media">
            <img
              class="project-bubble-marker__img"
              src="${safeLogo}"
              alt=""
              loading="lazy"
              onerror="this.onerror=null;this.src='logo/placeholder.png';"
            />
          </div>
        </div>
        <div class="project-bubble-marker__tail" style="--marker-accent: ${accent}" aria-hidden="true"></div>
      </div>
    `,
    iconSize: [64, 58],
    iconAnchor: [32, 58]
  });
}


/**
 * Applies current developer filter to a project list.
 * @param {Project[]} list
 * @returns {Project[]}
 */
function applyDeveloperFilter(list) {
  let result = list;

  if (selectedDeveloper && selectedDeveloper !== "__ALL__") {
    result = result.filter(
      (p) => String(p.developer || "") === String(selectedDeveloper)
    );
  }

  if (selectedArea && selectedArea !== "__ALL__") {
    result = result.filter(
      (p) => String(p.area || "").trim().toLowerCase() ===
             String(selectedArea).trim().toLowerCase()
    );
  }

  return result;
}

/**
 * Creates markers and attaches popups/cards.
 * Also updates marker count and auto-fit bounds.
 * @param {Project[]} loadedProjects
 */
function renderMarkers(loadedProjects) {
  if (!markerCluster) return;

  projects = loadedProjects;

  // Apply developer filter
  filteredProjects = applyDeveloperFilter(projects);

  allMarkers = [];
  markerCluster.clearLayers();

  for (const p of filteredProjects) {
    const marker = L.marker([p.lat, p.lng], {
      icon: createPurpleMarkerIcon(p)
    });

    // Marker click is the only action that opens the details card
    marker.on("click", () => {
      selectedProjectId = p.id;
      activeProjectId = p.id;
      setActiveMarkerVisual(p);
      openProjectCard(p);

      try {
        map?.setView(marker.getLatLng(), Math.max(map.getZoom(), 14), { animate: true });
      } catch {
        // ignore
      }
    });

    markerCluster.addLayer(marker);
    p._marker = marker;

    // Re-set icon after clustering so the marker HTML (including <img src>) is built
    // with the project's current Logo URL.
    try {
      marker.setIcon(createPurpleMarkerIcon(p));
    } catch {
      // ignore
    }


    allMarkers.push(marker);


  }

  // Update marker count pill
  if (markerCountValueEl) {
    markerCountValueEl.textContent = String(allMarkers.length);
  }

  // Auto-fit all visible markers on load / filter change
  if (allMarkers.length && map) {
    const bounds = L.latLngBounds(allMarkers.map((m) => m.getLatLng()));
    lastBounds = bounds;
    map.fitBounds(bounds, { padding: [50, 50], animate: true });
  }

  // Refresh sidebar after render
  renderSidebarList();
}

/**
 * Resets map view to show all markers.
 */
function resetView() {
  if (!map || !lastBounds) return;
  restoreFilteredMarkers();
  map.fitBounds(lastBounds, { padding: [50, 50], animate: true });
}

/** Returns currently selected project object if available. */
function getCurrentlySelectedProject() {
  if (!selectedProjectId) return null;
  return projects.find((x) => String(x.id) === String(selectedProjectId)) || null;
}

/** Returns the project whose details card is currently open. */
function getActiveProject() {
  if (!activeProjectId) return null;
  return projects.find((x) => String(x.id) === String(activeProjectId)) || null;
}

function clearActiveMarkerVisuals() {
  projects.forEach((x) => {
    if (x && x._marker && x._marker._icon) {
      x._marker._icon.classList.remove("project-bubble-marker--active");
    }
  });
}

function setActiveMarkerVisual(p) {
  clearActiveMarkerVisuals();
  p?._marker?._icon?.classList.add("project-bubble-marker--active");
  try {
    p?._marker?.bringToFront?.();
  } catch {
    // ignore
  }
}

/**
 * Temporarily show only the focused project's existing marker
 * so nearby pins do not crowd the high-zoom viewport.
 * Reuses the same Leaflet marker objects (no duplicates).
 * @param {Project} p
 */
function isolateProjectMarker(p) {
  if (!markerCluster || !p || !p._marker) return;
  for (const x of projects) {
    if (!x || !x._marker) continue;
    const selected = String(x.id) === String(p.id);
    const onMap = markerCluster.hasLayer(x._marker);
    if (selected) {
      if (!onMap) markerCluster.addLayer(x._marker);
    } else if (onMap) {
      markerCluster.removeLayer(x._marker);
    }
  }
}

function restoreFilteredMarkers() {
  if (!markerCluster) return;
  for (const x of filteredProjects) {
    if (!x || !x._marker) continue;
    if (!markerCluster.hasLayer(x._marker)) {
      markerCluster.addLayer(x._marker);
    }
  }
}

/**
 * Selects a project from the sidebar/search list:
 * highlight + focus marker, but do not open the details card.
 * @param {Project} p
 */
function selectProjectFromList(p) {
  if (!p || !p._marker) return;

  selectedProjectId = p.id;
  activeProjectId = null;
  closeProjectCard();
  renderSidebarList();
  focusProjectMarker(p);
}

/**
 * Highest zoom the map can use without exceeding tile-layer limits.
 * @returns {number}
 */
function getProjectFocusZoom() {
  if (!map) return 18;
  let maxZoom = 18;
  try {
    const fromMap = typeof map.getMaxZoom === "function" ? map.getMaxZoom() : 18;
    if (Number.isFinite(fromMap) && fromMap > 0 && fromMap !== Infinity) {
      maxZoom = fromMap;
    }
  } catch {
    maxZoom = 18;
  }
  return Math.max(maxZoom, 18);
}

/**
 * Reveals and focuses a project's existing map marker without opening the card.
 * Flies to max zoom on the exact coordinates so the logo marker dominates.
 * @param {Project} p
 */
function focusProjectMarker(p) {
  if (!p || !p._marker || !map) return;

  const marker = p._marker;
  const latlng = marker.getLatLng();
  const targetZoom = getProjectFocusZoom();

  isolateProjectMarker(p);

  const markActive = () => setActiveMarkerVisual(p);

  map.once("moveend", () => {
    if (map.getZoom() < targetZoom) {
      try {
        map.setView(latlng, targetZoom, { animate: false });
      } catch {
        // ignore
      }
    }
    markActive();
  });

  try {
    map.flyTo(latlng, targetZoom, {
      animate: true,
      duration: 1.2
    });
  } catch {
    try {
      map.setView(latlng, targetZoom, { animate: true });
    } catch {
      markActive();
    }
  }
}

/**
 * Positions the desktop card with its top-left corner at the marker point,
 * clamped to stay inside the viewport.
 * @param {Project} p
 * @param {{animState?: "preopen"|"open"|"closing"}} opts
 */
function positionDesktopCardBesideMarker(p, opts = {}) {
  if (!desktopCard || !map || !p || !p._marker) return;

  const animState = opts.animState || (desktopCard.classList.contains("desktopCard--closing") ? "closing" : desktopCard.classList.contains("desktopCard--open") ? "open" : "preopen");

  const markerLatLng = p._marker.getLatLng();
  const pt = map.latLngToContainerPoint(markerLatLng);

  const viewportW = map.getSize().x;
  const viewportH = map.getSize().y;

  const cardW = desktopCard.getBoundingClientRect().width || 340;
  const cardH = desktopCard.getBoundingClientRect().height || 240;

  const margin = 12;
  const safeTop = 12;
  const safeBottom = 12;

  const sidebarW = isMobileLayout() ? 0 : 320;
  const sidebarGap = isMobileLayout() ? 0 : 14;
  const minLeft = sidebarW + sidebarGap;
  const maxLeft = Math.max(margin, viewportW - cardW - margin);

  let left = pt.x;
  let top = pt.y;

  if (isMobileLayout()) {
    left = Math.max(margin, Math.min((viewportW - cardW) / 2, maxLeft));
    top = Math.max(safeTop, viewportH - cardH - safeBottom);
  } else {
    left = Math.max(minLeft, Math.min(left, maxLeft));
    top = Math.max(margin, Math.min(top, viewportH - cardH - margin));
  }

  desktopCard.style.left = "0px";
  desktopCard.style.top = "0px";

  const animYOffset = animState === "open" ? 0 : 8;
  desktopCard.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top + animYOffset)}px, 0)`;
}

// ------------------------
// Search logic
// ------------------------
function normalizeSearchToken(s) {
  return toCleanString(s).toLowerCase();
}

/**
 * Runs filtering using both fields:
 * - Project Name
 * - Developer
 *
 * @param {string} query
 * @returns {Project[]}
 */
function filterProjects(query) {
  const q = normalizeSearchToken(query);
  if (!q) return [];

  // Apply developer filter as well, so search results match displayed markers
  const base = applyDeveloperFilter(projects);

  return base.filter((p) => {
    const name = normalizeSearchToken(p.projectName);
    const dev = normalizeSearchToken(p.developer);
    return name.includes(q) || dev.includes(q) || normalizeSearchToken(p.clientName).includes(q);
  });
}

/**
 * Sidebar filtering across Client/Project/Developer.
 * Uses current selectedDeveloper filter as well.
 * @param {string} query
 */
function filterForSidebar(query) {
  const q = normalizeSearchToken(query);
  const base = applyDeveloperFilter(projects);
  if (!q) return base;

  return base.filter((p) => {
    const client = normalizeSearchToken(p.clientName);
    const proj = normalizeSearchToken(p.projectName);
    const dev = normalizeSearchToken(p.developer);
    return client.includes(q) || proj.includes(q) || dev.includes(q);
  });
}

/**
 * Renders full sidebar list (no dropdown) and highlights selected project.
 */
function renderSidebarList() {
  const list = filterForSidebar(sidebarQuery);
  const renderItem = (p) => {
    const isSelected = selectedProjectId !== null && String(p.id) === String(selectedProjectId);

    // Sidebar requirement: show Project Name + Developer (not Client only)
    const projectName = p.projectName || "—";
    const developerName = p.developer || "—";

    const logo = p.logoUrl || p.imageUrl || "";
    const safeLogo = logo && !String(logo).includes('"') ? getLogoPath(logo) : "logo/placeholder.png";


    return `
      <div
        class="sidebarItem ${isSelected ? "sidebarItem--selected" : ""}"
        role="listitem"
        tabindex="0"
        data-project-id="${p.id}"
        aria-selected="${isSelected ? "true" : "false"}"
      >
        <img
          class="sidebarItem__thumb"
          src="${safeLogo || ""}"
          alt="${escapeHtml(projectName)}"
          loading="lazy"
          onerror="this.style.display='none';"
        />

        <div class="sidebarItem__text">
          <div class="sidebarItem__title">${escapeHtml(projectName)}</div>
          <div class="sidebarItem__developer">${escapeHtml(developerName)}</div>
        </div>
      </div>
    `;
  };

  const html = list.map(renderItem).join("");
  if (sidebarList) sidebarList.innerHTML = html;
  if (sidebarDrawerList) sidebarDrawerList.innerHTML = html;

  // Wire click handlers (delegated for performance)
  const onClickItem = (e) => {
    const item = e.target.closest(".sidebarItem");
    if (!item) return;
    const id = item.getAttribute("data-project-id");
    const proj = projects.find((x) => String(x.id) === String(id));
    if (!proj || !proj._marker) return;

    selectProjectFromList(proj);

    // Close drawer / mobile sidebar on selection
    if (sidebarDrawer && sidebarDrawer.hidden === false) {
      closeSidebarDrawer();
    }
    closeMobileSidebar();
  };

  // attach once using named handler flags
  if (sidebarList && !sidebarList.__wired) {
    sidebarList.addEventListener("click", onClickItem);
    sidebarList.__wired = true;
  }
  if (sidebarDrawerList && !sidebarDrawerList.__wired) {
    sidebarDrawerList.addEventListener("click", onClickItem);
    sidebarDrawerList.__wired = true;
  }
}

/**
 * Debounced input handler for smoother typing.
 * @param {number} waitMs
 */
function debounce(waitMs) {
  let t = null;
  return (fn) => {
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), waitMs);
    };
  };
}

const onSearch = debounce(120)((value) => {
  // Search dropdown is kept, but selection opens shared cards (not Leaflet popup reliance)
  const results = filterProjects(value);
  renderSearchDropdown(results);
});

// ------------------------
// UI state management
// ------------------------
function showLoading(show) {
  loadingOverlay.hidden = !show;
}

function showError(message) {
  errorMessageEl.textContent = message || "Unknown error occurred while loading data.";
  errorOverlay.hidden = false;
}

function clearError() {
  errorOverlay.hidden = true;
  errorMessageEl.textContent = "";
}

function showEmpty(show) {
  emptyOverlay.hidden = !show;
}

/**
 * Attach card-follow behavior to map once.
 */
let cardFollowWired = false;
function wireCardFollowEvents() {
  if (!map || cardFollowWired) return;
  cardFollowWired = true;

  // Throttle to animation frames for smooth dragging/zooming.
  let scheduled = false;
  let lastProject = null;

  const update = () => {
    scheduled = false;
    const p = getActiveProject() || lastProject;
    if (!p || !desktopCard || desktopCard.hidden) return;
    try {
      positionDesktopCardBesideMarker(p);
    } catch {
      // ignore
    }
  };

  const schedule = (p) => {
    if (p) lastProject = p;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(update);
  };

  map.on("move", () => schedule());
  map.on("moveend", () => schedule());
  map.on("zoom", () => schedule());
  map.on("zoomend", () => schedule());
  map.on("resize", () => schedule());
  // Cluster expansion changes marker positions during zoom; move/zoom events cover it.
}

/**
 * Populate developer dropdown options after data load.
 * @param {Project[]} loaded
 */
function populateDeveloperDropdown(loaded) {
  if (!developerSelect) return;

  const devs = Array.from(
    new Set(loaded.map((p) => (p.developer ? String(p.developer).trim() : "")).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b));

  // Reset options
  developerSelect.innerHTML = "";

  const allOpt = document.createElement("option");
  allOpt.value = "__ALL__";
  allOpt.textContent = "All developers";
  developerSelect.appendChild(allOpt);

  for (const d of devs) {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d;
    developerSelect.appendChild(opt);
  }

  // Keep selection if possible, else default
  if (selectedDeveloper !== "__ALL__") {
    const found = devs.includes(selectedDeveloper);
    if (!found) selectedDeveloper = "__ALL__";
  }
  developerSelect.value = selectedDeveloper;
}

function populateAreaDropdown(loaded) {
  if (!areaSelect) return;

  const areas = Array.from(
    new Set(
      loaded
        .map((p) => (p.area ? String(p.area).trim() : ""))
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b));

  areaSelect.innerHTML = "";

  const allOpt = document.createElement("option");
  allOpt.value = "__ALL__";
  allOpt.textContent = "All areas";
  areaSelect.appendChild(allOpt);

  for (const area of areas) {
    const opt = document.createElement("option");
    opt.value = area;
    opt.textContent = area;
    areaSelect.appendChild(opt);
  }

  if (selectedArea !== "__ALL__" && !areas.includes(selectedArea)) {
    selectedArea = "__ALL__";
  }

  areaSelect.value = selectedArea;
  updateAreaFilterButtonState();
}

function updateAreaFilterButtonState() {
  if (!areaFilterBtn) return;
  const isActive = selectedArea && selectedArea !== "__ALL__";
  areaFilterBtn.classList.toggle("areaFilterBtn--active", isActive);
}

function isAreaPanelOpen() {
  return areaFilterPanel && !areaFilterPanel.hidden;
}

function setAreaPanelOpen(open) {
  if (!areaFilterPanel || !areaFilterBtn) return;
  areaFilterPanel.hidden = !open;
  areaFilterBtn.setAttribute("aria-expanded", open ? "true" : "false");
}

function toggleAreaPanel() {
  setAreaPanelOpen(!isAreaPanelOpen());
}

function closeAreaPanel() {
  setAreaPanelOpen(false);
}

function refreshFilteredViews() {
  closeDropdown();
  renderMarkers(projects);
  renderSidebarList();

  const q = searchInput?.value.trim();
  if (q) {
    renderSearchDropdown(filterProjects(q));
  }
}

function clearAllFilters() {
  selectedArea = "__ALL__";
  selectedDeveloper = "__ALL__";
  if (areaSelect) areaSelect.value = "__ALL__";
  if (developerSelect) developerSelect.value = "__ALL__";
  updateAreaFilterButtonState();
  closeAreaPanel();
  refreshFilteredViews();
}

async function loadAndRender() {
  showLoading(true);
  clearError();
  showEmpty(false);
  closeDropdown();

  try {
    const loaded = await fetchProjects();

    if (!loaded.length) {
      if (!map) initMap();
      if (markerCountValueEl) markerCountValueEl.textContent = "0";
      showEmpty(true);
      return;
    }

    if (!map) initMap();

    // Populate filters
    populateDeveloperDropdown(loaded);
    populateAreaDropdown(loaded);

    // Render markers applying filters
    renderMarkers(loaded);

    // Ensure search matches current filter (if any text is already present)
    if (searchInput.value.trim()) {
      const results = filterProjects(searchInput.value);
      renderSearchDropdown(results);
    } else {
      closeDropdown();
    }
  } catch (err) {
    console.error(err);
    showError(err?.message ? String(err.message) : "Failed to load project data.");
  } finally {
    showLoading(false);
  }
}

// Attach UI events (search dropdown, buttons, overlays)
function openProjectFromId(id) {
  const proj = projects.find((x) => String(x.id) === String(id));
  if (!proj || !proj._marker) return;
  selectProjectFromList(proj);
}

function isMobileLayout() {
  return mobileLayoutMq.matches;
}

function setMobileSidebarOpen(open) {
  if (!sidebarEl) return;
  sidebarEl.classList.toggle("is-open", open);
  document.body.classList.toggle("is-sidebar-open", open);
  if (sidebarOverlay) sidebarOverlay.hidden = !open;
  if (hamburgerBtn) hamburgerBtn.setAttribute("aria-expanded", open ? "true" : "false");
  if (isMobileLayout()) {
    sidebarEl.setAttribute("aria-hidden", open ? "false" : "true");
  } else {
    sidebarEl.removeAttribute("aria-hidden");
  }
  if (!open) closeAreaPanel();
}

function openMobileSidebar() {
  if (!isMobileLayout()) return;
  setMobileSidebarOpen(true);
}

function closeMobileSidebar() {
  setMobileSidebarOpen(false);
}

function toggleMobileSidebar() {
  if (!sidebarEl) return;
  if (sidebarEl.classList.contains("is-open")) closeMobileSidebar();
  else openMobileSidebar();
}

function syncMobileChrome() {
  if (hamburgerBtn) hamburgerBtn.hidden = !isMobileLayout();
  if (!isMobileLayout()) closeMobileSidebar();
}

/**
 * Mobile sidebar drawer helpers
 */
function openSidebarDrawer() {
  openMobileSidebar();
  if (!sidebarDrawer) return;
  sidebarDrawer.hidden = false;
}
function closeSidebarDrawer() {
  closeMobileSidebar();
  if (!sidebarDrawer) return;
  sidebarDrawer.hidden = true;
}

function wireUI() {
  // Search input (top)
  searchInput.addEventListener(
    "input",
    (e) => {
      const value = e.target.value;
      if (!value.trim()) {
        closeDropdown();
        return;
      }
      onSearch(value);
    },
    { passive: true }
  );

  // Developer dropdown filter
  if (developerSelect) {
    developerSelect.addEventListener("change", () => {
      selectedDeveloper = developerSelect.value || "__ALL__";
      refreshFilteredViews();
    });
  }

  // Area filter
  if (areaSelect) {
    areaSelect.addEventListener("change", () => {
      selectedArea = areaSelect.value || "__ALL__";
      updateAreaFilterButtonState();
      refreshFilteredViews();
    });
  }

  if (areaFilterBtn) {
    areaFilterBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleAreaPanel();
    });
  }

  if (areaFilterCloseBtn) {
    areaFilterCloseBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeAreaPanel();
    });
  }

  if (clearAreaFilterBtn) {
    clearAreaFilterBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      clearAllFilters();
    });
  }

  if (areaFilterPanel) {
    areaFilterPanel.addEventListener("click", (e) => {
      e.stopPropagation();
    });
  }

  // Sidebar search (desktop/tablet)
  if (sidebarSearchInput) {
    const sync = () => {
      sidebarQuery = sidebarSearchInput.value || "";
      renderSidebarList();
    };
    sidebarSearchInput.addEventListener("input", sync, { passive: true });
    if (sidebarClearBtn) {
      sidebarClearBtn.addEventListener("click", () => {
        sidebarSearchInput.value = "";
        sidebarQuery = "";
        renderSidebarList();
      });
    }
  }

  // Sidebar search (drawer / mobile)
  if (sidebarDrawerSearchInput) {
    sidebarDrawerSearchInput.addEventListener(
      "input",
      () => {
        sidebarQuery = sidebarDrawerSearchInput.value || "";
        renderSidebarList();
      },
      { passive: true }
    );
  }

  // Map click closes card
  if (map) {
    map.on("click", () => closeProjectCard());
  }

  // Mobile hamburger / overlay
  if (hamburgerBtn) {
    hamburgerBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMobileSidebar();
    });
  }
  if (sidebarCloseBtn) {
    sidebarCloseBtn.addEventListener("click", () => closeMobileSidebar());
  }
  if (sidebarOverlay) {
    sidebarOverlay.addEventListener("click", () => closeMobileSidebar());
  }
  if (sidebarDrawerCloseBtn) {
    sidebarDrawerCloseBtn.addEventListener("click", () => closeSidebarDrawer());
  }
  if (sidebarDrawerOverlay) {
    sidebarDrawerOverlay.addEventListener("click", () => closeSidebarDrawer());
  }

  syncMobileChrome();
  if (typeof mobileLayoutMq.addEventListener === "function") {
    mobileLayoutMq.addEventListener("change", syncMobileChrome);
  } else if (typeof mobileLayoutMq.addListener === "function") {
    mobileLayoutMq.addListener(syncMobileChrome);
  }

  if (mobileCardCloseBtn) {
    mobileCardCloseBtn.addEventListener("click", () => closeProjectCard());
  }

  // Close dropdowns when clicking outside
  document.addEventListener("click", (e) => {
    const target = e.target;
    const clickedInsideSearch =
      target && (searchDropdown.contains(target) || searchInput.contains(target));
    if (!clickedInsideSearch) {
      closeDropdown();
    }

    if (areaFilterPanel && areaFilterBtn) {
      const clickedInsideArea =
        areaFilterPanel.contains(target) || areaFilterBtn.contains(target);
      if (!clickedInsideArea && isAreaPanelOpen()) {
        closeAreaPanel();
      }
    }
  });

  // Reset search (top)
  resetSearchBtn.addEventListener("click", () => {
    searchInput.value = "";
    closeDropdown();
    searchInput.focus();
  });

  // Reset view
  resetViewBtn.addEventListener("click", () => {
    resetView();
  });

  // Retry on error
  retryBtn.addEventListener("click", () => {
    loadAndRender();
  });

  // Keyboard: escape closes dropdowns
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeDropdown();
      closeAreaPanel();
      searchInput.blur();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isAreaPanelOpen()) {
      closeAreaPanel();
    }
  });
}

// Boot
wireUI();
loadAndRender();
