package expo.modules.syncservice

import android.content.Context
import android.content.Intent
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Keeps Backup Now, Restore and list imports going after you leave the app
// (src/backgroundSync.js): start() runs SyncForegroundService, which shows
// a progress notification and keeps the app's process (and the JavaScript
// doing the sync) alive; update() changes the notification; stop() ends
// it. start() must be called while the app is on screen: Android doesn't
// let an app in the background start one.
class SyncServiceModule : Module() {
  private val context: Context?
    get() = appContext.reactContext?.applicationContext

  override fun definition() = ModuleDefinition {
    Name("SyncService")

    // upload: true shows the upload icon, false the download one.
    // Returns whether it started.
    Function("start") { title: String, text: String, upload: Boolean ->
      val ctx = context ?: return@Function false
      val intent = Intent(ctx, SyncForegroundService::class.java)
        .putExtra("title", title)
        .putExtra("text", text)
        .putExtra("upload", upload)
      try {
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(intent) else ctx.startService(intent)
        true
      } catch (e: Exception) {
        false
      }
    }

    // total 0: a moving bar, while the amount isn't known yet.
    Function("update") { title: String, text: String, done: Int, total: Int, upload: Boolean ->
      val ctx = context ?: return@Function
      if (SyncForegroundService.running) SyncForegroundService.show(ctx, title, text, done, total, upload)
    }

    Function("stop") {
      val ctx = context ?: return@Function
      ctx.stopService(Intent(ctx, SyncForegroundService::class.java))
    }
  }
}
