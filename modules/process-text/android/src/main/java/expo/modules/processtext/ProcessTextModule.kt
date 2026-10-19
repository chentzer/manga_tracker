package expo.modules.processtext

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Hands the app text highlighted in another app (ProcessTextActivity):
// takeText() returns it once, then null; "onText" says one is waiting
// while the app is running.
class ProcessTextModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ProcessText")
    Events("onText")

    OnCreate { instance = this@ProcessTextModule }
    OnDestroy { if (instance === this@ProcessTextModule) instance = null }

    Function("takeText") {
      val text = pendingText
      pendingText = null
      text
    }
  }

  fun notifyText() {
    try {
      sendEvent("onText", mapOf<String, Any>())
    } catch (e: Exception) {
      // the app isn't listening yet; it takes the text when it starts
    }
  }

  companion object {
    @Volatile
    var pendingText: String? = null

    @Volatile
    var instance: ProcessTextModule? = null
  }
}
