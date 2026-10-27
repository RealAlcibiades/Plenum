# plenum-isolated-preview (Android)

Shows an artifact's HTML in a separate WebView process (`android:process=":isolatedpreview"`). The page has no Capacitor
bridge and no JavaScript interface, cannot read files or content, reaches no network (every request except data: is
refused), keeps no storage and cannot navigate away. The window is FLAG_SECURE. iOS does not use this plugin; artifacts
are pictures there.

- `IsolatedPreview.show({ html, title? })`: at most 8 MB. The HTML is staged in the app's cache folder, read once by the
  preview process and deleted.
