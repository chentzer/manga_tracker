package expo.modules.syncservice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

// The foreground service behind SyncServiceModule. While it runs, Android
// treats the app as in use, so its process isn't frozen or killed when
// you switch away, and a partial wake lock keeps the CPU on with the
// screen off. Its notification shows the progress; tapping it opens the
// app.
class SyncForegroundService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra("title") ?: "Syncing with Google Drive"
    val text = intent?.getStringExtra("text") ?: ""
    val upload = intent?.getBooleanExtra("upload", true) ?: true
    val notification = build(this, title, text, 0, 0, upload)
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    running = true
    if (wakeLock == null) {
      val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
      // At most an hour, in case stop() never comes.
      wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "mangatracker:sync").apply { acquire(60 * 60 * 1000L) }
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    running = false
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    super.onDestroy()
  }

  companion object {
    const val NOTIFICATION_ID = 4127
    private const val CHANNEL_ID = "sync"

    @Volatile
    var running = false

    fun show(context: Context, title: String, text: String, done: Int, total: Int, upload: Boolean) {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      manager.notify(NOTIFICATION_ID, build(context, title, text, done, total, upload))
    }

    private fun build(context: Context, title: String, text: String, done: Int, total: Int, upload: Boolean): Notification {
      val builder =
        if (Build.VERSION.SDK_INT >= 26) {
          val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
          if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
              NotificationChannel(CHANNEL_ID, "Backup and restore", NotificationManager.IMPORTANCE_LOW)
            )
          }
          Notification.Builder(context, CHANNEL_ID)
        } else {
          @Suppress("DEPRECATION")
          Notification.Builder(context)
        }
      builder
        .setSmallIcon(if (upload) android.R.drawable.stat_sys_upload else android.R.drawable.stat_sys_download)
        .setContentTitle(title)
        .setContentText(text)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setProgress(if (total > 0) total else 0, if (total > 0) done.coerceIn(0, total) else 0, total <= 0)
      context.packageManager.getLaunchIntentForPackage(context.packageName)?.let { launch ->
        builder.setContentIntent(
          PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        )
      }
      if (Build.VERSION.SDK_INT >= 31) builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
      return builder.build()
    }
  }
}
