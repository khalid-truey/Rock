using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal sealed class RockControl : Form
{
    private readonly string root;
    private readonly string node;
    private readonly Label hostValue = new Label();
    private readonly Label rockValue = new Label();
    private readonly Label device = new Label();
    private readonly Label footer = new Label();
    private readonly TextBox detail = new TextBox();
    private readonly Button start = new Button();
    private readonly Button stop = new Button();
    private readonly Button hostCheck = new Button();
    private readonly Button rockCheck = new Button();
    private readonly Timer timer = new Timer();
    private bool busy;
    private bool hostAllowed;
    private string lastHost = "";
    private readonly Color ink = Color.FromArgb(229, 235, 244);
    private readonly Color muted = Color.FromArgb(155, 172, 195);
    private readonly Color green = Color.FromArgb(80, 213, 175);

    [STAThread]
    private static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try
        {
            if (args.Length == 2 && args[0] == "--diagnose")
            {
                string installation = FindRoot();
                File.WriteAllText(args[1], "Installation: " + installation + Environment.NewLine + "Node: " + FindNode(installation));
                return;
            }
            var form = new RockControl();
            if (args.Length == 2 && args[0] == "--preview")
            {
                form.Show();
                Application.DoEvents();
                var deadline = DateTime.UtcNow.AddSeconds(15);
                while (form.busy && DateTime.UtcNow < deadline)
                { Application.DoEvents(); System.Threading.Thread.Sleep(25); }
                form.timer.Stop();
                Application.DoEvents();
                using (var image = new Bitmap(form.Width, form.Height))
                { form.DrawToBitmap(image, new Rectangle(Point.Empty, image.Size)); image.Save(args[1]); }
                form.Close();
                return;
            }
            Application.Run(form);
        }
        catch (Exception error)
        { MessageBox.Show(error.Message, "Rock Control", MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }

    private RockControl()
    {
        root = FindRoot();
        node = FindNode(root);
        Text = "Rock Control";
        ClientSize = new Size(600, 432);
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 10F);
        AutoScaleMode = AutoScaleMode.Dpi;
        BackColor = Color.FromArgb(16, 24, 39);
        ForeColor = ink;
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(24), ColumnCount = 1, RowCount = 7 };
        foreach (float height in new float[] { 40, 30, 78, 25, 106, 72, 33 })
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, height));
        Controls.Add(layout);
        layout.Controls.Add(new Label { Text = "Rock Control", Font = new Font("Segoe UI", 21F, FontStyle.Bold), AutoSize = true }, 0, 0);
        layout.Controls.Add(new Label { Text = "One Laya host. Your PC and laptop.", ForeColor = muted, AutoSize = true }, 0, 1);
        var cards = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, Margin = new Padding(0, 7, 0, 0) };
        cards.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        cards.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        cards.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        cards.Controls.Add(StatusCard("LAYA HOST", hostValue), 0, 0);
        cards.Controls.Add(StatusCard("ROCK MCP", rockValue), 1, 0);
        layout.Controls.Add(cards, 0, 2);
        device.Text = "Checking this installation...";
        device.ForeColor = muted;
        device.Dock = DockStyle.Fill;
        device.TextAlign = ContentAlignment.MiddleLeft;
        layout.Controls.Add(device, 0, 3);
        var buttons = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 2, Margin = new Padding(0, 5, 0, 5) };
        buttons.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        buttons.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        buttons.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
        buttons.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
        SetupButton(start, "Start Laya", Color.FromArgb(21, 112, 93));
        SetupButton(stop, "Stop Laya", Color.FromArgb(126, 52, 66));
        SetupButton(hostCheck, "Laya Host Status", Color.FromArgb(40, 54, 74));
        SetupButton(rockCheck, "Rock Status", Color.FromArgb(40, 54, 74));
        buttons.Controls.Add(start, 0, 0); buttons.Controls.Add(stop, 1, 0);
        buttons.Controls.Add(hostCheck, 0, 1); buttons.Controls.Add(rockCheck, 1, 1);
        layout.Controls.Add(buttons, 0, 4);
        detail.Multiline = true; detail.ReadOnly = true; detail.BorderStyle = BorderStyle.None;
        detail.BackColor = BackColor; detail.ForeColor = ink; detail.Dock = DockStyle.Fill;
        detail.Text = "Laya starts only when you press Start Laya.";
        detail.TabStop = false;
        layout.Controls.Add(detail, 0, 5);
        footer.Text = "Closing this window keeps Laya running. Start is always manual.";
        footer.ForeColor = muted; footer.Font = new Font("Segoe UI", 8.5F); footer.Dock = DockStyle.Fill;
        layout.Controls.Add(footer, 0, 6);
        start.Enabled = stop.Enabled = false;
        start.Click += async (s, e) => await RefreshState("start", true);
        stop.Click += async (s, e) => await RefreshState("stop", true);
        hostCheck.Click += async (s, e) => await RefreshState("host-status", true);
        rockCheck.Click += async (s, e) => await RefreshState("rock-status", true);
        Shown += async (s, e) => { await RefreshState("status", true); if (!IsDisposed) timer.Start(); };
        timer.Interval = 4000;
        timer.Tick += async (s, e) => await RefreshState("status", false);
        FormClosed += (s, e) => timer.Dispose();
    }

    private Panel StatusCard(string title, Label value)
    {
        var card = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(28, 39, 57), Margin = new Padding(0, 0, 8, 0), Padding = new Padding(12, 7, 10, 7) };
        value.Text = "CHECKING"; value.ForeColor = ink; value.Dock = DockStyle.Bottom; value.Height = 30;
        value.Font = new Font("Segoe UI", 16F, FontStyle.Bold);
        card.Controls.Add(value);
        card.Controls.Add(new Label { Text = title, AutoSize = true, ForeColor = muted, Dock = DockStyle.Top, Font = new Font("Segoe UI", 8.5F) });
        return card;
    }

    private void SetupButton(Button button, string text, Color color)
    {
        button.Text = text; button.Dock = DockStyle.Fill; button.Margin = new Padding(0, 0, 8, 8);
        button.BackColor = color; button.ForeColor = ink; button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderSize = 0; button.Cursor = Cursors.Hand;
        button.AccessibleName = text;
    }

    private async Task RefreshState(string action, bool showDetails)
    {
        if (busy) return;
        busy = true;
        start.Enabled = stop.Enabled = hostCheck.Enabled = rockCheck.Enabled = false;
        try
        {
            var result = await Task.Run(() => RunAdapter(action));
            if (IsDisposed) return;
            if (!result.ContainsKey("ok") || !Convert.ToBoolean(result["ok"])) throw new Exception(Get(result, "message"));
            hostAllowed = Convert.ToBoolean(result["canControlHost"]);
            lastHost = Get(result, "hostStatus");
            PaintStatus(hostValue, lastHost); PaintStatus(rockValue, Get(result, "rockStatus"));
            device.Text = Get(result, "device");
            if (device.Text.Length == 0) device.Text = hostAllowed ? "This PC hosts Laya · manual start" : "This computer uses a remote Laya host";
            if (showDetails)
            {
                string message = Get(result, "message");
                if (message.Length == 0) message = action == "rock-status" ? Get(result, "rockMessage") : Get(result, "hostMessage");
                detail.Text = message + Environment.NewLine + "Checked " + DateTime.Now.ToString("HH:mm:ss");
            }
        }
        catch (Exception error)
        {
            if (!IsDisposed) { detail.Text = error.Message; hostValue.Text = "CHECK FAILED"; hostAllowed = false; }
        }
        finally
        {
            busy = false;
            if (!IsDisposed)
            {
                hostCheck.Enabled = rockCheck.Enabled = true;
                start.Enabled = hostAllowed && lastHost == "offline";
                stop.Enabled = hostAllowed && (lastHost == "ready" || lastHost == "loading");
            }
        }
    }

    private void PaintStatus(Label label, string status)
    {
        label.Text = status.ToUpperInvariant();
        label.ForeColor = status == "ready" || status == "running" ? green : Color.FromArgb(245, 187, 99);
    }

    private Dictionary<string, object> RunAdapter(string action)
    {
        var info = new ProcessStartInfo(node, "\"" + Path.Combine(root, "integrations", "codex", "control.mjs") + "\" " + action)
        { WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        using (var process = Process.Start(info))
        {
            var output = process.StandardOutput.ReadToEndAsync();
            var errors = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(15000)) { process.Kill(); throw new Exception("Status check timed out. Try again."); }
            Task.WaitAll(output, errors);
            if (string.IsNullOrWhiteSpace(output.Result)) throw new Exception("Cannot read Rock status. " + errors.Result.Trim());
            return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(output.Result);
        }
    }

    private static string Get(Dictionary<string, object> value, string key)
    { return value.ContainsKey(key) && value[key] != null ? Convert.ToString(value[key]) : ""; }
    private static string FindRoot()
    {
        var folder = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);
        for (int i = 0; folder != null && i < 5; i++, folder = folder.Parent)
            if (File.Exists(Path.Combine(folder.FullName, "integrations", "codex", "control.mjs"))) return folder.FullName;
        using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Rock"))
        {
            string installed = key == null ? null : key.GetValue("InstallRoot") as string;
            if (!string.IsNullOrEmpty(installed) && File.Exists(Path.Combine(installed, "integrations", "codex", "control.mjs"))) return installed;
        }
        if (File.Exists(Path.Combine(InstalledLocation.Root, "integrations", "codex", "control.mjs"))) return InstalledLocation.Root;
        throw new Exception("Rock installation was not found. Run Rock setup or keep this executable in the installation's bin folder.");
    }
    private static string FindNode(string root)
    {
        string bundled = Path.Combine(root, "bin", "node.exe");
        if (File.Exists(bundled)) return bundled;
        string standard = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
        if (File.Exists(standard)) return standard;
        foreach (string entry in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        { string candidate = Path.Combine(entry.Trim('"'), "node.exe"); if (File.Exists(candidate)) return candidate; }
        throw new Exception("Node.js is missing. Run Rock setup first.");
    }
}
