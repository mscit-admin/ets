package ly.ets.alerts.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.widget.ListView
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import ly.ets.alerts.AlertsBus
import ly.ets.alerts.R
import ly.ets.alerts.Session
import ly.ets.alerts.core.UrlRules
import ly.ets.alerts.data.Settings
import ly.ets.alerts.sync.Sync
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** Recent alerts (last 50) with severity colour, time and read state. */
class MainActivity : AppCompatActivity() {
    private lateinit var adapter: AlertAdapter
    private lateinit var status: TextView
    private lateinit var progress: ProgressBar
    private val io: ExecutorService = Executors.newSingleThreadExecutor()
    private var refreshing = false

    private val onChange: () -> Unit = { render() }

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* nothing to do either way */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!Settings.get(this).isPaired) {
            openDevice()
            finish()
            return
        }
        setContentView(R.layout.activity_main)
        status = findViewById(R.id.status)
        progress = findViewById(R.id.progress)
        adapter = AlertAdapter(this)
        val list: ListView = findViewById(R.id.alert_list)
        list.adapter = adapter
        list.emptyView = findViewById(R.id.empty)
        list.setOnItemClickListener { _, _, position, _ ->
            val alert = adapter.getItem(position)
            OpenAlertActivity.openAlert(this, alert.id, alert.link)
        }

        askNotificationPermission()
        Session.ensureRunning(this)
        if (savedInstanceState == null) refresh()
    }

    override fun onStart() {
        super.onStart()
        if (!::adapter.isInitialized) return
        AlertsBus.register(onChange)
        render()
    }

    override fun onStop() {
        AlertsBus.unregister(onChange)
        super.onStop()
    }

    override fun onDestroy() {
        io.shutdown()
        super.onDestroy()
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.menu_main, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean = when (item.itemId) {
        R.id.action_refresh -> {
            refresh()
            true
        }
        R.id.action_device -> {
            openDevice()
            true
        }
        else -> super.onOptionsItemSelected(item)
    }

    private fun openDevice() {
        startActivity(Intent(this, DeviceActivity::class.java))
    }

    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun refresh() {
        if (refreshing) return
        refreshing = true
        progress.visibility = View.VISIBLE
        io.execute {
            val result = Sync.run(applicationContext, refreshCached = true)
            runOnUiThread {
                refreshing = false
                if (isFinishing || isDestroyed) return@runOnUiThread
                progress.visibility = View.GONE
                if (result is Sync.Result.Failed) {
                    Toast.makeText(this, R.string.error_unreachable, Toast.LENGTH_LONG).show()
                }
                render()
            }
        }
    }

    private fun render() {
        if (isFinishing) return
        val settings = Settings.get(this)
        if (!settings.isPaired) {
            openDevice()
            finish()
            return
        }
        adapter.submit(settings.recent)
        val host = settings.baseUrl?.let(UrlRules::displayHost).orEmpty()
        status.text = getString(R.string.status_line, settings.unread, host)
    }
}
