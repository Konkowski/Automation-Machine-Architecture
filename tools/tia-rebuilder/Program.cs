// ============================================================
// TiaRebuilder: creates a TIA Portal project from an AMA package whose blocks
// were imported from TIA Portal. Nothing is regenerated: the original objects
// (OB / FC / FB / DB, PLC data types) are imported back exactly as exported,
// the PLC tags are created again and the stations are rebuilt from their
// original type identifiers, modules, addresses and IP addresses.
//
// Every step is in try/catch: one failure does not stop the build, it is
// written to BuildReport.txt.
//
// Usage: TiaRebuilder.exe --package <package folder> --out <project folder> [--ui]
// ============================================================
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Web.Script.Serialization;
using Siemens.Engineering;
using Siemens.Engineering.Compiler;
using Siemens.Engineering.HW;
using Siemens.Engineering.HW.Features;
using Siemens.Engineering.SW;
using Siemens.Engineering.SW.Blocks;
using Siemens.Engineering.SW.Tags;
using Siemens.Engineering.SW.TechnologicalObjects;
using Siemens.Engineering.SW.Types;

internal static class Program
{
    static Program()
    {
        AppDomain.CurrentDomain.AssemblyResolve += ResolveSiemensAssemblies;
    }

    private static Assembly ResolveSiemensAssemblies(object sender, ResolveEventArgs args)
    {
        var name = new AssemblyName(args.Name).Name;
        var apiDir = Environment.GetEnvironmentVariable("SIEMENS_ENGINEERING_DIR");
        if (!string.IsNullOrEmpty(apiDir))
        {
            var dllPath = Path.Combine(apiDir, name + ".dll");
            if (File.Exists(dllPath)) return Assembly.LoadFrom(dllPath);
        }
        return null;
    }

    private static int Main(string[] args)
    {
        try { return Rebuilder.Run(args); }
        catch (Exception e)
        {
            Rebuilder.Log("FATAL: " + e);
            Rebuilder.WriteReport();
            return 2;
        }
    }
}

internal static class Rebuilder
{
    private static readonly List<string> Report = new List<string>();
    private static string _pkg = ".";
    private static int _ok, _fail, _manual;

    public static void Log(string s) { Console.WriteLine(s); Console.Out.Flush(); Report.Add(s); }
    private static void Ok(string s) { _ok++; Log("  [OK]     " + s); }
    private static void Manual(string s) { _manual++; Log("  [MANUAL] " + s); }
    private static void Fail(string s, Exception e)
    {
        _fail++;
        Log("  [FAIL]   " + s + (e == null ? "" : " -> " + Flat(e.Message)));
    }
    private static string Flat(string s) { return (s ?? "").Replace("\r", " ").Replace("\n", " ").Trim(); }
    private static void Status(string s) { Console.WriteLine("##STATUS " + s); Console.Out.Flush(); }
    private static void Progress(int done, int total, string s) { Console.WriteLine("##PROGRESS " + done + " " + total + " " + s); Console.Out.Flush(); }

    public static void WriteReport()
    {
        try { File.WriteAllLines(Path.Combine(_pkg, "BuildReport.txt"), Report); } catch { }
    }

    // ---- small helpers over the parsed JSON ----
    private static Dictionary<string, object> Obj(object o) { return o as Dictionary<string, object> ?? new Dictionary<string, object>(); }
    private static List<object> Arr(object o)
    {
        if (o is ArrayList) return ((ArrayList)o).Cast<object>().ToList();
        if (o is object[]) return ((object[])o).ToList();
        return new List<object>();
    }
    private static string Str(Dictionary<string, object> o, string key)
    {
        object v;
        return o.TryGetValue(key, out v) && v != null ? v.ToString() : "";
    }
    private static int Int(Dictionary<string, object> o, string key)
    {
        int n;
        return int.TryParse(Str(o, key), out n) ? n : 0;
    }

    public static int Run(string[] args)
    {
        string outDir = null;
        bool ui = false;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--package" && i + 1 < args.Length) _pkg = args[++i];
            else if (args[i] == "--out" && i + 1 < args.Length) outDir = args[++i];
            else if (args[i] == "--ui") ui = true;
        }
        if (outDir == null) { Console.Error.WriteLine("Usage: TiaRebuilder.exe --package <folder> --out <folder> [--ui]"); return 1; }

        var json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        var cfg = Obj(json.DeserializeObject(File.ReadAllText(Path.Combine(_pkg, "rebuild.json"))));
        var projectName = Str(cfg, "project");
        Log("== TiaRebuilder: " + projectName + " ==");

        if (Directory.Exists(Path.Combine(outDir, projectName)))
        {
            Log("The project folder already exists: " + Path.Combine(outDir, projectName));
            Log("Delete it (or choose another package folder) and run again.");
            WriteReport();
            return 1;
        }
        Directory.CreateDirectory(outDir);

        Status("Starting TIA Portal (this can take a minute)");
        using (var tia = new TiaPortal(ui ? TiaPortalMode.WithUserInterface : TiaPortalMode.WithoutUserInterface))
        {
            Status("Creating the project");
            Project project = tia.Projects.Create(new DirectoryInfo(outDir), projectName);
            Ok("project created in " + Path.Combine(outDir, projectName));
            try
            {
                // languages used by the comments of the original objects must be active, or the import refuses them
                foreach (var c in Arr(cfg.ContainsKey("languages") ? cfg["languages"] : null).Select(x => x.ToString()))
                {
                    try
                    {
                        var ls = project.LanguageSettings;
                        var lang = ls.Languages.Find(new CultureInfo(c));
                        if (lang != null && !ls.ActiveLanguages.Contains(lang)) { ls.ActiveLanguages.Add(lang); Ok("project language " + c); }
                    }
                    catch (Exception e) { Fail("project language " + c, e); }
                }

                var plcs = new Dictionary<string, PlcSoftware>();
                BuildHardware(project, Arr(cfg.ContainsKey("stations") ? cfg["stations"] : null), plcs);
                foreach (var m in Arr(cfg.ContainsKey("manual") ? cfg["manual"] : null)) Manual(m.ToString());

                Manual("Hardware: stations, modules, slots, I/O addresses and IP addresses are as they were. Module and drive PARAMETERS (channel settings, safety, drive commissioning) are not carried over: check them in TIA Portal.");
                if (plcs.Count == 0) Log("!! No PLC could be created: the software was not imported. The hardware is saved anyway.");
                else BuildSoftware(cfg, plcs);

                Log("== SUMMARY ==");
                Log("  done: " + _ok + "   to do by hand: " + _manual + "   failed: " + _fail);
            }
            finally
            {
                Status("Saving the project");
                try { project.Save(); Log("  [OK]     project saved"); } catch (Exception e) { Log("  [FAIL]   project not saved -> " + Flat(e.Message)); }
                WriteReport();
                if (!ui) { try { project.Close(); } catch { } }
            }
        }
        Log("Report written: " + Path.Combine(_pkg, "BuildReport.txt"));
        return 0;
    }

    // =====================================================================
    // Hardware: every station from its original type identifiers
    // =====================================================================
    private static bool IsRack(string type) { return type.StartsWith("System:Rack") || type.Contains("/R/") || type.StartsWith("OrderNumber:6ES7 590"); }

    private static void BuildHardware(Project project, List<object> stations, Dictionary<string, PlcSoftware> plcs)
    {
        Log("== HARDWARE ==");
        Subnet subnet = null;
        IoSystem ioSystem = null;
        var created = new List<Tuple<Device, Dictionary<string, object>>>();
        int n = 0;
        foreach (var st in stations.Select(Obj))
        {
            Progress(++n, stations.Count, "station " + Str(st, "name"));
            var name = Str(st, "name");
            var items = Arr(st["items"]).Select(Obj).ToList();
            var top = items.Where(i => Int(i, "depth") == 0 && Str(i, "type").Length > 0 && !IsRack(Str(i, "type"))).ToList();
            var head = top.FirstOrDefault(i => Str(i, "classification") == "CPU")
                ?? top.FirstOrDefault(i => Str(i, "classification") == "HM")
                ?? top.FirstOrDefault();
            if (head == null) { Manual(name + ": no module with a type identifier, create it by hand."); continue; }

            Device device;
            try { device = project.Devices.CreateWithItem(Str(head, "type"), Str(head, "name"), name); }
            catch (Exception e)
            {
                var t = Str(head, "type");
                if (t.StartsWith("GSD:")) Manual(name + " (" + t + "): install the manufacturer's GSDML file in TIA Portal, then add the device by hand.");
                else if (t.StartsWith("OrderNumber:6AV")) Manual(name + " (" + t + "): HMI panel not created (WinCC is needed for it in this TIA Portal). Add it by hand.");
                else Fail("station " + name + " (" + t + ")", e);
                continue;
            }
            Ok("station " + name + " (" + Str(head, "type") + ")");
            created.Add(Tuple.Create(device, st));

            // the other modules, in their original slots
            foreach (var mod in top.Where(i => !ReferenceEquals(i, head)).OrderBy(i => Int(i, "position")))
            {
                string type = Str(mod, "type"), mname = Str(mod, "name");
                int pos = Int(mod, "position");
                bool done = false;
                Exception last = null;
                foreach (var host in Hosts(device))
                {
                    try
                    {
                        if (!host.CanPlugNew(type, mname, pos)) continue;
                        host.PlugNew(type, mname, pos);
                        done = true;
                        break;
                    }
                    catch (Exception e) { last = e; }
                }
                if (done) Ok("  module slot " + pos + " " + mname + " (" + type + ")");
                else if (All(device).Any(x => x.Name == mname)) Ok("  module slot " + pos + " " + mname + " (already part of the station)");
                else Fail("  module slot " + pos + " " + mname + " (" + type + ") of " + name + " could not be plugged", last);
            }

            // I/O addresses as they were (the tags point at them)
            foreach (var raw in items)
            {
                var addrs = Arr(raw.ContainsKey("addresses") ? raw["addresses"] : null).Select(Obj).Where(a => Int(a, "start") >= 0).ToList();
                if (addrs.Count == 0) continue;
                var real = All(device).FirstOrDefault(x => x.Name == Str(raw, "name") && x.Addresses.Any());
                if (real == null) continue;
                foreach (var a in addrs)
                {
                    try
                    {
                        var target = real.Addresses.FirstOrDefault(x => x.IoType.ToString() == Str(a, "io"));
                        if (target != null && target.StartAddress != Int(a, "start")) target.StartAddress = Int(a, "start");
                    }
                    catch (Exception e) { Fail("  address " + Str(a, "io") + Int(a, "start") + " of " + Str(raw, "name"), e); }
                }
            }

            // PLC software of this station
            foreach (var di in All(device))
            {
                try
                {
                    var sc = ((IEngineeringServiceProvider)di).GetService<SoftwareContainer>();
                    var sw = sc == null ? null : sc.Software as PlcSoftware;
                    if (sw != null) plcs[sw.Name] = sw;
                }
                catch { }
            }
        }

        // network: IP addresses, one subnet, one PROFINET IO system on the first PLC
        Log("== NETWORK ==");
        foreach (var pair in created.OrderByDescending(p => All(p.Item1).Any(IsPlc)))
        {
            var device = pair.Item1;
            var rawNode = Arr(pair.Item2["items"]).Select(Obj).SelectMany(i => Arr(i.ContainsKey("nodes") ? i["nodes"] : null).Select(Obj)).FirstOrDefault(x => Str(x, "ip").Length > 0);
            if (rawNode == null) continue;
            NetworkInterface ni = null;
            foreach (var di in All(device))
            {
                try
                {
                    var s = ((IEngineeringServiceProvider)di).GetService<NetworkInterface>();
                    if (s != null && s.Nodes.Any()) { ni = s; break; }
                }
                catch { }
            }
            if (ni == null) { Manual(device.Name + ": no network interface found, set the IP " + Str(rawNode, "ip") + " by hand."); continue; }
            var node = ni.Nodes.First();
            try
            {
                node.SetAttribute("Address", Str(rawNode, "ip"));
                if (Str(rawNode, "mask").Length > 0) { try { node.SetAttribute("SubnetMask", Str(rawNode, "mask")); } catch { } }
                if (subnet == null) subnet = node.CreateAndConnectToSubnet(Str(rawNode, "subnet").Length > 0 ? Str(rawNode, "subnet") : "PN/IE_1");
                else node.ConnectToSubnet(subnet);
                Ok("network " + device.Name + " = " + Str(rawNode, "ip"));
            }
            catch (Exception e) { Fail("network " + device.Name + " = " + Str(rawNode, "ip"), e); }
            try
            {
                if (ioSystem == null && ni.IoControllers.Any()) { ioSystem = ni.IoControllers.First().CreateIoSystem("PNIO_1"); Ok("PROFINET IO system created on " + device.Name); }
                else if (ioSystem != null && ni.IoConnectors.Any()) { ni.IoConnectors.First().ConnectToIoSystem(ioSystem); Ok("  " + device.Name + " assigned to the IO system"); }
            }
            catch (Exception e) { Fail("IO system for " + device.Name, e); }
        }
    }

    private static bool IsPlc(DeviceItem di)
    {
        try { return ((IEngineeringServiceProvider)di).GetService<SoftwareContainer>() != null; } catch { return false; }
    }

    private static IEnumerable<DeviceItem> All(Device d)
    {
        foreach (DeviceItem i in d.DeviceItems) foreach (var x in All(i)) yield return x;
    }
    private static IEnumerable<DeviceItem> All(DeviceItem i)
    {
        yield return i;
        foreach (DeviceItem c in i.DeviceItems) foreach (var x in All(c)) yield return x;
    }
    // where a module can be plugged: the rack first, then the head module (bus adapters, GSD submodules)
    private static IEnumerable<DeviceItem> Hosts(Device d)
    {
        foreach (DeviceItem i in d.DeviceItems) yield return i;
        foreach (DeviceItem i in d.DeviceItems) foreach (DeviceItem c in i.DeviceItems) yield return c;
    }

    // =====================================================================
    // Software: data types, tags, then the original blocks
    // =====================================================================
    private static void BuildSoftware(Dictionary<string, object> cfg, Dictionary<string, PlcSoftware> plcs)
    {
        Func<string, PlcSoftware> plcFor = n => plcs.ContainsKey(n) ? plcs[n] : plcs.Values.First();
        var imports = Arr(cfg.ContainsKey("imports") ? cfg["imports"] : null).Select(Obj).ToList();
        var tags = Arr(cfg.ContainsKey("tags") ? cfg["tags"] : null).Select(Obj).ToList();
        int total = imports.Count + 1, done = 0;

        Log("== PLC DATA TYPES ==");
        foreach (var im in imports.Where(i => Str(i, "kind") == "type"))
        {
            Progress(++done, total, "data type " + Str(im, "name"));
            try
            {
                var grp = TypeGroup(plcFor(Str(im, "plc")).TypeGroup, Str(im, "folder"));
                grp.Types.Import(new FileInfo(Path.Combine(_pkg, Str(im, "file"))), ImportOptions.Override);
                Ok("data type " + Str(im, "name"));
            }
            catch (Exception e) { Fail("data type " + Str(im, "name"), e); }
        }

        Log("== PLC TAGS ==");
        Progress(++done, total, "PLC tags");
        int made = 0;
        foreach (var t in tags)
        {
            try
            {
                var plc = plcFor(Str(t, "plc"));
                var tableName = Str(t, "table").Length > 0 ? Str(t, "table") : "Default tag table";
                var table = FindTable(plc.TagTableGroup, tableName) ?? plc.TagTableGroup.TagTables.Create(tableName);
                var tag = table.Tags.Find(Str(t, "name")) ?? table.Tags.Create(Str(t, "name"), Str(t, "type"), Str(t, "address"));
                if (Str(t, "comment").Length > 0)
                {
                    try { foreach (var item in tag.Comment.Items) { item.Text = Str(t, "comment"); break; } } catch { }
                }
                made++;
            }
            catch (Exception e) { Fail("tag " + Str(t, "name") + " (" + Str(t, "type") + " " + Str(t, "address") + ")", e); }
        }
        Ok(made + " of " + tags.Count + " PLC tags created");

        Log("== TECHNOLOGY OBJECTS ==");
        foreach (var im in imports.Where(i => Str(i, "kind") == "technology"))
        {
            Progress(++done, total, "technology object " + Str(im, "name"));
            try
            {
                plcFor(Str(im, "plc")).TechnologicalObjectGroup.TechnologicalObjects.Import(new FileInfo(Path.Combine(_pkg, Str(im, "file"))), ImportOptions.Override);
                Ok("technology object " + Str(im, "name"));
            }
            catch (Exception e) { Fail("technology object " + Str(im, "name") + " (create it by hand and assign it to its module)", e); }
        }
        if (imports.Any(i => Str(i, "kind") == "technology"))
            Manual("Technology objects: open each one in TIA Portal and select its module and channel again (the link to the hardware is not carried over), otherwise they do not compile.");

        // Blocks reference each other: what fails is tried again after the others exist.
        Log("== BLOCKS ==");
        var pending = imports.Where(i => Str(i, "kind") == "block").ToList();
        var errors = new Dictionary<string, string>();
        for (int pass = 1; pass <= 4 && pending.Count > 0; pass++)
        {
            var next = new List<Dictionary<string, object>>();
            foreach (var im in pending)
            {
                if (pass == 1) Progress(++done, total, Str(im, "blockKind") + " " + Str(im, "name"));
                try
                {
                    var grp = BlockGroup(plcFor(Str(im, "plc")).BlockGroup, Str(im, "folder"));
                    grp.Blocks.Import(new FileInfo(Path.Combine(_pkg, Str(im, "file"))), ImportOptions.Override,
                        SWImportOptions.IgnoreMissingReferencedObjects | SWImportOptions.IgnoreStructuralChanges | SWImportOptions.IgnoreUnitAttributes);
                    Ok(Str(im, "blockKind") + " " + Str(im, "name") + (Str(im, "folder").Length > 0 ? "  ->  " + Str(im, "folder") : "") + (pass > 1 ? "  (pass " + pass + ")" : ""));
                    errors.Remove(Str(im, "name"));
                }
                catch (Exception e) { errors[Str(im, "name")] = Flat(e.Message); next.Add(im); }
            }
            if (next.Count == pending.Count) break;   // no progress: stop retrying
            pending = next;
        }
        foreach (var kv in errors) { _fail++; Log("  [FAIL]   block " + kv.Key + " not imported -> " + kv.Value); }

        Log("== COMPILE ==");
        foreach (var plc in plcs.Values)
        {
            Status("Compiling " + plc.Name);
            try
            {
                var res = plc.GetService<ICompilable>().Compile();
                Log("  " + plc.Name + ": " + res.State + ", errors " + res.ErrorCount + ", warnings " + res.WarningCount);
                int shown = 0;
                Walk(res.Messages, "", ref shown, 40);
                if (res.ErrorCount > shown) Log("    ... (" + (res.ErrorCount - shown) + " more errors: open the project in TIA Portal)");
            }
            catch (Exception e) { Fail("compile " + plc.Name, e); }
        }
    }

    private static void Walk(CompilerResultMessageComposition msgs, string ctx, ref int shown, int max)
    {
        foreach (CompilerResultMessage m in msgs)
        {
            if (shown >= max) return;
            var here = string.IsNullOrEmpty(m.Path) ? ctx : (ctx.Length > 0 ? ctx + " / " : "") + m.Path;
            if (m.State == CompilerResultState.Error && !string.IsNullOrEmpty(m.Description)) { Log("    ERR " + here + " | " + Flat(m.Description)); shown++; }
            Walk(m.Messages, here, ref shown, max);
        }
    }

    private static PlcBlockGroup BlockGroup(PlcBlockGroup root, string folder)
    {
        PlcBlockGroup g = root;
        foreach (var seg in folder.Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries))
            g = g.Groups.Find(seg) ?? g.Groups.Create(seg);
        return g;
    }

    private static PlcTypeGroup TypeGroup(PlcTypeGroup root, string folder)
    {
        PlcTypeGroup g = root;
        foreach (var seg in folder.Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries))
            g = g.Groups.Find(seg) ?? g.Groups.Create(seg);
        return g;
    }

    private static PlcTagTable FindTable(PlcTagTableGroup g, string name)
    {
        var t = g.TagTables.Find(name);
        if (t != null) return t;
        foreach (PlcTagTableGroup c in g.Groups) { t = FindTable(c, name); if (t != null) return t; }
        return null;
    }
}
