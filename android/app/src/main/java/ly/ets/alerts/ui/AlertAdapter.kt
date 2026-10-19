package ly.ets.alerts.ui

import android.content.Context
import android.graphics.Typeface
import android.text.format.DateUtils
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.TextView
import androidx.core.content.ContextCompat
import ly.ets.alerts.R
import ly.ets.alerts.core.Alert
import ly.ets.alerts.core.Severity
import ly.ets.alerts.notify.Notifier

class AlertAdapter(private val context: Context) : BaseAdapter() {
    private var items: List<Alert> = emptyList()

    fun submit(newItems: List<Alert>) {
        items = newItems
        notifyDataSetChanged()
    }

    override fun getCount(): Int = items.size

    override fun getItem(position: Int): Alert = items[position]

    override fun getItemId(position: Int): Long = items[position].id

    override fun hasStableIds(): Boolean = true

    override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
        val view = convertView ?: LayoutInflater.from(context).inflate(R.layout.item_alert, parent, false)
        val holder = (view.tag as? Holder) ?: Holder(view).also { view.tag = it }
        val alert = items[position]

        holder.strip.setBackgroundColor(Notifier.severityColor(context, alert.severity))
        holder.title.text = alert.title.ifBlank { context.getString(R.string.public_alert_title) }
        holder.title.setTypeface(null, if (alert.read) Typeface.NORMAL else Typeface.BOLD)
        holder.body.text = alert.body
        holder.body.visibility = if (alert.body.isBlank()) View.GONE else View.VISIBLE

        val severityLabel = context.getString(
            when (alert.severity) {
                Severity.CRITICAL -> R.string.severity_critical
                Severity.WARNING -> R.string.severity_warning
                Severity.INFO -> R.string.severity_info
            },
        )
        val time = alert.createdAtMillis()?.let {
            DateUtils.formatDateTime(
                context,
                it,
                DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_SHOW_TIME or DateUtils.FORMAT_ABBREV_MONTH,
            )
        }.orEmpty()
        val state = context.getString(if (alert.read) R.string.state_read else R.string.state_unread)
        holder.meta.text = listOf(severityLabel, time, state).filter { it.isNotEmpty() }.joinToString(" · ")
        holder.meta.setTextColor(Notifier.severityColor(context, alert.severity))

        view.setBackgroundColor(
            ContextCompat.getColor(context, if (alert.read) R.color.row_read else R.color.row_unread),
        )
        return view
    }

    private class Holder(view: View) {
        val strip: View = view.findViewById(R.id.severity_strip)
        val title: TextView = view.findViewById(R.id.alert_title)
        val body: TextView = view.findViewById(R.id.alert_body)
        val meta: TextView = view.findViewById(R.id.alert_meta)
    }
}
