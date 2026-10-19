package expo.modules.processtext

import android.app.Activity
import android.content.Intent
import android.os.Bundle

// Receives text highlighted in another app ("Search AniManga Tracker" in the
// menu over the selection), keeps it for the app to take (ProcessTextModule
// takeText), and opens the app. Shows nothing itself.
class ProcessTextActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val text = intent?.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()?.trim()
    if (!text.isNullOrEmpty()) {
      ProcessTextModule.pendingText = text
      packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        startActivity(launch)
      }
      ProcessTextModule.instance?.notifyText()
    }
    finish()
  }
}
