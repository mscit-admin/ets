package ly.ets.alerts.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings as AndroidSettings
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SwitchCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import ly.ets.alerts.AlertsBus
import ly.ets.alerts.BuildConfig
import ly.ets.alerts.R
import ly.ets.alerts.Session
import ly.ets.alerts.core.Fingerprint
import ly.ets.alerts.core.PairingException
import ly.ets.alerts.core.PairingPayload
import ly.ets.alerts.core.UrlRules
import ly.ets.alerts.data.Settings
import ly.ets.alerts.net.ApiException
import ly.ets.alerts.net.EtsApi
import ly.ets.alerts.net.Http
import ly.ets.alerts.net.UnauthorizedException
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import javax.net.ssl.SSLException

/**
 * Pairing screen. Unpaired: scan the QR from ETS Profile -> أجهزتي, or paste its JSON.
 * Paired: server URL, user name, certificate pin, «اتصال دائم» switch and «فصل».
 */
class DeviceActivity : AppCompatActivity() {
    private lateinit var settings: Settings
    private lateinit var unpairedGroup: View
    private lateinit var pairedGroup: View
    private lateinit var pasteInput: EditText
    private lateinit var progress: ProgressBar
    private lateinit var pairButton: Button
    private lateinit var scanButton: Button
    private lateinit var serverValue: TextView
    private lateinit var nameValue: TextView
    private lateinit var trustValue: TextView
    private lateinit var versionValue: TextView
    private lateinit var persistentSwitch: SwitchCompat
    private val io: ExecutorService = Executors.newSingleThreadExecutor()
    private var busy = false

    private val onChange: () -> Unit = { render() }

    private val scanLauncher = registerForActivityResult(ScanContract()) { result ->
        val contents = result.contents ?: return@registerForActivityResult
        pasteInput.setText(contents)
        startPairing(contents)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_device)
        settings = Settings.get(this)

        unpairedGroup = findViewById(R.id.unpaired_group)
        pairedGroup = findViewById(R.id.paired_group)
        pasteInput = findViewById(R.id.paste_input)
        progress = findViewById(R.id.pair_progress)
        pairButton = findViewById(R.id.pair_button)
        scanButton = findViewById(R.id.scan_button)
        serverValue = findViewById(R.id.server_value)
        nameValue = findViewById(R.id.name_value)
        trustValue = findViewById(R.id.trust_value)
        versionValue = findViewById(R.id.version_value)
        persistentSwitch = findViewById(R.id.persistent_switch)

        scanButton.setOnClickListener { launchScanner() }
        pairButton.setOnClickListener { startPairing(pasteInput.text.toString()) }
        findViewById<Button>(R.id.unpair_button).setOnClickListener { confirmUnpair() }
        findViewById<Button>(R.id.battery_button).setOnClickListener { openBatterySettings() }
        findViewById<Button>(R.id.open_alerts_button).setOnClickListener { openMain() }

        persistentSwitch.setOnCheckedChangeListener { _, checked ->
            if (settings.persistentConnection != checked) {
                settings.persistentConnection = checked
                Session.ensureRunning(this)
            }
        }
        versionValue.text = getString(R.string.app_version, BuildConfig.VERSION_NAME)

        if (savedInstanceState == null && intent.getBooleanExtra(EXTRA_UNPAIR_HINT, false)) {
            // The server could not confirm the revoke: the device may still be listed on the web.
            AlertDialog.Builder(this)
                .setTitle(R.string.unpair)
                .setMessage(R.string.unpair_remote_failed)
                .setPositiveButton(android.R.string.ok, null)
                .show()
        }
    }

    override fun onStart() {
        super.onStart()
        AlertsBus.register(onChange)
        render()
        if (settings.isPaired) refreshProfile()
    }

    override fun onStop() {
        AlertsBus.unregister(onChange)
        super.onStop()
    }

    override fun onDestroy() {
        io.shutdown()
        super.onDestroy()
    }

    private fun render() {
        val paired = settings.isPaired
        unpairedGroup.visibility = if (paired) View.GONE else View.VISIBLE
        pairedGroup.visibility = if (paired) View.VISIBLE else View.GONE
        progress.visibility = if (busy) View.VISIBLE else View.GONE
        pairButton.isEnabled = !busy
        scanButton.isEnabled = !busy
        supportActionBar?.setDisplayHomeAsUpEnabled(paired)
        if (paired) {
            serverValue.text = settings.baseUrl.orEmpty()
            nameValue.text = settings.fullName.orEmpty().ifBlank { "—" }
            trustValue.text = settings.certSha256?.let { getString(R.string.trust_pinned, Fingerprint.display(it)) }
                ?: getString(R.string.trust_system)
            persistentSwitch.isChecked = settings.persistentConnection
        }
    }

    override fun onSupportNavigateUp(): Boolean {
        openMain()
        return true
    }

    private fun openMain() {
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
        finish()
    }

    private fun launchScanner() {
        val options = ScanOptions()
            .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            .setPrompt(getString(R.string.scan_prompt))
            .setBeepEnabled(false)
            .setOrientationLocked(false)
        scanLauncher.launch(options)
    }

    private fun startPairing(raw: String) {
        if (busy) return
        val payload = try {
            PairingPayload.parse(raw)
        } catch (e: PairingException) {
            showError(getString(pairingErrorText(e.reason)))
            return
        }
        val trust = payload.certSha256?.let { getString(R.string.trust_pinned, Fingerprint.display(it)) }
            ?: getString(R.string.trust_system)
        AlertDialog.Builder(this)
            .setTitle(R.string.confirm_pair_title)
            .setMessage(getString(R.string.confirm_pair_message, payload.baseUrl, trust))
            .setPositiveButton(R.string.pair) { _, _ -> pair(payload) }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun pair(payload: PairingPayload) {
        busy = true
        render()
        val deviceName = listOf(Build.MANUFACTURER, Build.MODEL)
            .filter { !it.isNullOrBlank() }
            .joinToString(" ")
            .ifBlank { "Android" }
            .take(64)
        io.execute {
            val outcome: Result<String> = try {
                val api = EtsApi(payload.baseUrl, Http.client(payload.certSha256), null, Session.userAgent())
                val r = api.pair(payload.code, deviceName, BuildConfig.VERSION_NAME)
                settings.savePairing(payload.baseUrl, payload.certSha256, r.token, r.deviceId, r.fullName, r.lang)
                Result.success(r.fullName)
            } catch (e: IOException) {
                Result.failure(e)
            } catch (e: RuntimeException) {
                // e.g. Keystore failure while wrapping the token.
                Result.failure(e)
            }
            runOnUiThread {
                busy = false
                if (isFinishing || isDestroyed) return@runOnUiThread
                outcome.onSuccess { name ->
                    pasteInput.text = null
                    Session.ensureRunning(this)
                    Session.syncSoon(this)
                    Toast.makeText(this, getString(R.string.paired_as, name.ifBlank { "—" }), Toast.LENGTH_LONG).show()
                    render()
                    openMain()
                }.onFailure { e ->
                    render()
                    showError(networkErrorText(e))
                }
            }
        }
    }

    private fun refreshProfile() {
        io.execute {
            val api = Session.api(this) ?: return@execute
            try {
                val me = api.me()
                settings.updateProfile(me.fullName)
                runOnUiThread {
                    if (isFinishing || isDestroyed) return@runOnUiThread
                    render()
                    me.serverVersion?.let {
                        versionValue.text = getString(R.string.app_and_server_version, BuildConfig.VERSION_NAME, it)
                    }
                }
            } catch (e: UnauthorizedException) {
                Session.revoked(this)
            } catch (e: IOException) {
                // Offline or VPN down: keep showing cached values.
            }
        }
    }

    private fun confirmUnpair() {
        AlertDialog.Builder(this)
            .setTitle(R.string.unpair)
            .setMessage(R.string.confirm_unpair_message)
            .setPositiveButton(R.string.unpair) { _, _ -> unpair() }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    /** Best-effort server revoke (short timeout), then an unconditional local wipe. */
    private fun unpair() {
        if (busy) return
        busy = true
        findViewById<Button>(R.id.unpair_button).isEnabled = false
        io.execute {
            val needsWebCleanup = Session.unpair(applicationContext)
            runOnUiThread {
                busy = false
                if (isDestroyed) return@runOnUiThread
                // Start a clean task so no screen of the old pairing remains on the back stack.
                startActivity(
                    Intent(this, DeviceActivity::class.java)
                        .putExtra(EXTRA_UNPAIR_HINT, needsWebCleanup)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
                )
                finish()
            }
        }
    }

    private fun openBatterySettings() {
        try {
            startActivity(Intent(AndroidSettings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, R.string.battery_settings_missing, Toast.LENGTH_LONG).show()
        }
    }

    private fun showError(message: String) {
        AlertDialog.Builder(this)
            .setTitle(R.string.pair_failed)
            .setMessage(message)
            .setPositiveButton(android.R.string.ok, null)
            .show()
    }

    private fun pairingErrorText(reason: PairingException.Reason): Int = when (reason) {
        PairingException.Reason.EMPTY -> R.string.err_payload_empty
        PairingException.Reason.NOT_JSON -> R.string.err_payload_not_json
        PairingException.Reason.UNSUPPORTED_VERSION -> R.string.err_payload_version
        PairingException.Reason.BAD_URL -> R.string.err_payload_url
        PairingException.Reason.BAD_CODE -> R.string.err_payload_code
        PairingException.Reason.BAD_FINGERPRINT -> R.string.err_payload_fingerprint
    }

    private fun networkErrorText(e: Throwable): String = when (e) {
        is ApiException -> when (e.status) {
            400, 401, 403, 404, 409, 410 -> getString(R.string.err_code_rejected)
            else -> getString(R.string.err_server_status, e.status)
        }
        is SSLException -> getString(R.string.err_tls)
        is UnknownHostException, is ConnectException, is NoRouteToHostException, is SocketTimeoutException ->
            getString(R.string.err_unreachable_vpn)
        is IOException -> getString(R.string.err_unreachable_vpn)
        else -> getString(R.string.err_generic)
    }

    companion object {
        private const val EXTRA_UNPAIR_HINT = "unpair_hint"
    }
}
