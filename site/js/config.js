/* Where the diary lives online. */

// The published site: invite messages point here even from a local copy.
export const SITE_URL = "https://danielr12321.github.io/restaurant-diary/";

// The shared diary's database (the same free Supabase project as the cocktail app,
// in tables of its own). The publishable key is made to ship inside apps; the
// database rules in supabase/schema.sql are what protect the data.
export const SUPABASE_URL = "https://islsgpinvajfovpsdrfe.supabase.co";
export const SUPABASE_KEY = "sb_publishable_PlMG7J59oZ0mnezNGrg86Q_Mh9_qGZ-";

export const IS_LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);

// Test hooks, honoured only when the site runs on this computer.
function devSetting(name) {
  if (!IS_LOCAL) return "";
  try {
    return localStorage.getItem("diary:dev:" + name) || "";
  } catch (err) {
    return "";
  }
}

export const PLACES_BASE = devSetting("places-base") || "https://places.googleapis.com/v1";
export const MENU_FUNCTION_URL = devSetting("menu-url") || SUPABASE_URL + "/functions/v1/find-menu";
export const MENU_FUNCTION_IS_LOCAL = !!devSetting("menu-url");
