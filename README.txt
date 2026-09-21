AFRI LUDO - HOW TO KEEP THE WEB CHANGES WHEN YOU EXPORT FROM GODOT
==================================================================

Everything I changed lives in the EXPORTED files. When you export again from Godot, Godot writes new
index.html / index.pck files and the changes are gone, unless you do the steps below once.

FILES IN THIS PACK
  custom_shell.html     the web page (fit-to-screen, blurred backdrop, picture menu + picture "Select game mode",
                        loading screen). Godot fills in the $GODOT_... parts on every export.
  afri_ui_font.tres     font with the icon pack + emoji, so icons show on web (the web export has no emoji font)
  loading_splash.png    the loading picture
  background_new.png    the new scenic background used behind every game page (1672 x 941)

ONE-TIME SETUP IN GODOT (4.x)
 1. Copy custom_shell.html, afri_ui_font.tres and loading_splash.png into your project folder (next to Main.gd).
 2. Project > Project Settings > GUI > Theme > Custom Font  =  res://afri_ui_font.tres
 3. Project > Project Settings > Application > Boot Splash > Image  =  res://loading_splash.png
 4. Project > Export > Web > HTML > Custom HTML Shell  =  res://custom_shell.html
 5. Replace the old background picture in your project (kigali_pic1_background.png) with background_new.png
    (same file name is easiest: copy background_new.png over it and let Godot re-import).
 6. Open Main.gd and use Search/Replace (Ctrl+Shift+F) for these texts:
      "CREATE ROOM"                                   ->  "FIND MATCH"
      "create_room"  (only the one SENT to the server) ->  "find_match"
      "Create a private room or join friends with a room code."
                                                      ->  "Find a match automatically, or join friends with a room code."
      "Room created • share the code"              ->  "Searching for players • match starts automatically"
      "No players in a room yet.\nCreate a room or join a friend's room."
                                                      ->  "No players yet.\nTap FIND MATCH, or join a friend's room."
      "Play locally today • Online play coming later"
                                                      ->  "Play locally or online • Find a match in seconds"
    (the server, ludo-backend/server.js, already understands "find_match")

EVERY TIME YOU EXPORT
 - Before exporting, open custom_shell.html and change  const AFRI_BUILD = 'v9';  to a new number (v9, v10 ...).
   The number is shown in the corner of the menu and makes browsers download the new game file.
 - Export to a folder, then upload ALL exported files to the ludo-frontend repo (index.html, index.pck, index.js,
   index.wasm, index.png, ...). Check that index.pck on GitHub has the new size.

GOOD TO KNOW
 - The picture menu and picture "Select game mode" page are drawn by the web page on top of the game and pass
   taps on to the game's own buttons. They rely on the game's own main menu and mode screen keeping their current
   layout (PLAY button position, three mode buttons). If you move those buttons in Godot, tell me and I will
   re-align the pictures.
 - The lobby, board, leaderboard, profile and settings screens are still the game's own screens.
