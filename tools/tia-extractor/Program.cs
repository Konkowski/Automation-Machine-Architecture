// ============================================================
// TiaExtractor: reads a TIA Portal project through TIA Openness and writes
// everything AMA needs into a folder. It only READS: the project is never saved.
//
//   <out>/manifest.json                    what was exported, and what could not be
//   <out>/hardware.json                    devices, modules, order numbers, addresses, IPs
//   <out>/<plc>/blocks/<folders>/<n>.xml   OB / FB / FC / DB (SimaticML)
//   <out>/<plc>/tags/<folders>/<n>.xml     PLC tag tables
//   <out>/<plc>/types/<folders>/<n>.xml    PLC data types (UDT)
//   <out>/<plc>/system/<n>.xml             instance DBs of timers, counters and instructions (System blocks)
//   <out>/<plc>/technology/<n>.xml         technology objects (counters, axes...)
//
// Usage: TiaExtractor.exe --project <file.apXX> --out <folder> [--ui]
// ============================================================
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using Siemens.Engineering;
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

    // The Openness DLLs are not copied next to the exe: load them from the TIA installation.
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
        try { return Extractor.Run(args); }
        catch (Exception e)
        {
            Console.Error.WriteLine("FATAL: " + e);
            return 2;
        }
    }
}

internal static class Extractor
{
    private static readonly List<string> Errors = new List<string>();
    private static int _blocks, _tagTables, _types;
    private static int _done, _total;

    // Lines starting with ## are read by AMA to draw the progress bar.
    private static void Status(string text) { Console.WriteLine("##STATUS " + text); Console.Out.Flush(); }

    public static int Run(string[] args)
    {
        string project = null, outDir = null;
        bool ui = false;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--project" && i + 1 < args.Length) project = args[++i];
            else if (args[i] == "--out" && i + 1 < args.Length) outDir = args[++i];
            else if (args[i] == "--ui") ui = true;
        }
        if (project == null || outDir == null)
        {
            Console.Error.WriteLine("Usage: TiaExtractor.exe --project <file.apXX> --out <folder> [--ui]");
            return 1;
        }
        if (!File.Exists(project)) { Console.Error.WriteLine("Project not found: " + project); return 1; }
        Directory.CreateDirectory(outDir);

        Status("Starting TIA Portal (this can take a minute)");
        using (var tia = new TiaPortal(ui ? TiaPortalMode.WithUserInterface : TiaPortalMode.WithoutUserInterface))
        {
            Status("Opening the project");
            Project prj = tia.Projects.Open(new FileInfo(project));
            try
            {
                var devices = new List<Device>();
                devices.AddRange(prj.Devices);
                CollectDevices(prj.DeviceGroups, devices);
                try { devices.AddRange(prj.UngroupedDevicesGroup.Devices); } catch { }

                // how much there is to export, for the progress bar
                Status("Counting blocks, tags and data types");
                foreach (var dev in devices)
                    foreach (DeviceItem item in AllItems(dev.DeviceItems))
                    {
                        var p = PlcOf(item);
                        if (p != null) _total += Count(p.BlockGroup) + Count(p.TagTableGroup) + Count(p.TypeGroup) + CountSystem(p) + CountTech(p);
                    }

                var hw = new StringBuilder();
                var plcNames = new List<string>();
                hw.Append("{\n  \"devices\": [");
                bool firstDev = true;
                foreach (var dev in devices)
                {
                    if (!firstDev) hw.Append(",");
                    firstDev = false;
                    hw.Append("\n    {\"name\": ").Append(Js(dev.Name))
                      .Append(", \"type\": ").Append(Js(Safe(() => dev.TypeIdentifier)))
                      .Append(", \"items\": [");
                    bool firstItem = true;
                    foreach (DeviceItem item in dev.DeviceItems) WriteItem(hw, item, ref firstItem, 0);
                    hw.Append("]}");

                    foreach (DeviceItem item in AllItems(dev.DeviceItems))
                    {
                        PlcSoftware plc = PlcOf(item);
                        if (plc == null) continue;
                        var plcDir = Path.Combine(outDir, FileName(plc.Name));
                        Console.WriteLine("PLC " + plc.Name + " (" + dev.Name + ")");
                        plcNames.Add(plc.Name);
                        ExportBlocks(plc.BlockGroup, Path.Combine(plcDir, "blocks"));
                        ExportTagTables(plc.TagTableGroup, Path.Combine(plcDir, "tags"));
                        ExportTypes(plc.TypeGroup, Path.Combine(plcDir, "types"));
                        ExportSystem(plc, Path.Combine(plcDir, "system"));
                        ExportTech(plc, Path.Combine(plcDir, "technology"));
                    }
                }
                hw.Append("\n  ]\n}\n");
                File.WriteAllText(Path.Combine(outDir, "hardware.json"), hw.ToString(), new UTF8Encoding(false));

                var mf = new StringBuilder();
                mf.Append("{\n  \"tool\": \"AMA TiaExtractor 1\",\n  \"project\": ").Append(Js(prj.Name))
                  .Append(",\n  \"plcs\": [").Append(string.Join(", ", plcNames.Select(Js)))
                  .Append("],\n  \"blocks\": ").Append(_blocks)
                  .Append(",\n  \"tagTables\": ").Append(_tagTables)
                  .Append(",\n  \"types\": ").Append(_types)
                  .Append(",\n  \"errors\": [").Append(string.Join(", ", Errors.Select(Js))).Append("]\n}\n");
                File.WriteAllText(Path.Combine(outDir, "manifest.json"), mf.ToString(), new UTF8Encoding(false));

                Console.WriteLine("Done: " + _blocks + " blocks, " + _tagTables + " tag tables, " + _types + " data types, " + Errors.Count + " not exported.");
            }
            finally
            {
                try { prj.Close(); } catch { }   // never saved
            }
        }
        return 0;
    }

    // ---- software ----
    private static PlcSoftware PlcOf(DeviceItem item)
    {
        try
        {
            var sc = ((IEngineeringServiceProvider)item).GetService<SoftwareContainer>();
            return sc == null ? null : sc.Software as PlcSoftware;
        }
        catch { return null; }
    }

    private static int Count(PlcBlockGroup g) { int n = g.Blocks.Count; foreach (PlcBlockGroup c in g.Groups) n += Count(c); return n; }
    private static int Count(PlcTagTableGroup g) { int n = g.TagTables.Count; foreach (PlcTagTableGroup c in g.Groups) n += Count(c); return n; }
    private static int Count(PlcTypeGroup g) { int n = g.Types.Count; foreach (PlcTypeGroup c in g.Groups) n += Count(c); return n; }

    private static void ExportBlocks(PlcBlockGroup group, string dir)
    {
        foreach (PlcBlock b in group.Blocks)
            Export(dir, b.Name, f => b.Export(f, ExportOptions.WithDefaults), "block", ref _blocks);
        foreach (PlcBlockGroup g in group.Groups) ExportBlocks(g, Path.Combine(dir, FileName(g.Name)));
    }

    private static void ExportTagTables(PlcTagTableGroup group, string dir)
    {
        foreach (PlcTagTable t in group.TagTables)
            Export(dir, t.Name, f => t.Export(f, ExportOptions.WithDefaults), "tag table", ref _tagTables);
        foreach (PlcTagTableGroup g in group.Groups) ExportTagTables(g, Path.Combine(dir, FileName(g.Name)));
    }

    // System blocks hold the instance DBs TIA creates for timers, counters and instructions.
    // Siemens' own system FBs in there cannot be exported: that is normal and not reported.
    private static IEnumerable<PlcBlock> SystemBlocks(PlcSoftware plc)
    {
        var list = new List<PlcBlock>();
        try { foreach (PlcSystemBlockGroup g in plc.BlockGroup.SystemBlockGroups) Collect(g, list); } catch { }
        return list;
    }
    private static void Collect(PlcSystemBlockGroup g, List<PlcBlock> into)
    {
        foreach (PlcBlock b in g.Blocks) into.Add(b);
        foreach (PlcSystemBlockGroup c in g.Groups) Collect(c, into);
    }
    private static int CountSystem(PlcSoftware plc) { return SystemBlocks(plc).Count(); }

    private static void ExportSystem(PlcSoftware plc, string dir)
    {
        foreach (var b in SystemBlocks(plc))
        {
            _done++;
            Console.WriteLine("##PROGRESS " + _done + " " + _total + " system block " + b.Name);
            Console.Out.Flush();
            if (!(b is DataBlock)) continue;   // only the data blocks are ours to carry over
            try
            {
                Directory.CreateDirectory(dir);
                var file = new FileInfo(Path.Combine(dir, FileName(b.Name) + ".xml"));
                if (file.Exists) file.Delete();
                b.Export(file, ExportOptions.WithDefaults);
                _blocks++;
            }
            catch { }
        }
    }

    private static IEnumerable<TechnologicalInstanceDB> TechObjects(PlcSoftware plc)
    {
        var list = new List<TechnologicalInstanceDB>();
        try { CollectTech(plc.TechnologicalObjectGroup, list); } catch { }
        return list;
    }
    private static void CollectTech(TechnologicalInstanceDBGroup g, List<TechnologicalInstanceDB> into)
    {
        foreach (TechnologicalInstanceDB t in g.TechnologicalObjects) into.Add(t);
        try { foreach (TechnologicalInstanceDBGroup c in g.Groups) CollectTech(c, into); } catch { }
    }
    private static int CountTech(PlcSoftware plc) { return TechObjects(plc).Count(); }

    private static void ExportTech(PlcSoftware plc, string dir)
    {
        foreach (var t in TechObjects(plc))
            Export(dir, t.Name, f => t.Export(f, ExportOptions.WithDefaults), "technology object", ref _blocks);
    }

    private static void ExportTypes(PlcTypeGroup group, string dir)
    {
        foreach (PlcType t in group.Types)
            Export(dir, t.Name, f => t.Export(f, ExportOptions.WithDefaults), "data type", ref _types);
        foreach (PlcTypeGroup g in group.Groups) ExportTypes(g, Path.Combine(dir, FileName(g.Name)));
    }

    private static void Export(string dir, string name, Action<FileInfo> export, string kind, ref int counter)
    {
        _done++;
        Console.WriteLine("##PROGRESS " + _done + " " + _total + " " + kind + " " + name);
        Console.Out.Flush();
        try
        {
            Directory.CreateDirectory(dir);
            var file = new FileInfo(Path.Combine(dir, FileName(name) + ".xml"));
            if (file.Exists) file.Delete();
            export(file);
            counter++;
        }
        catch (Exception e)
        {
            // know-how protected or inconsistent objects cannot be exported: report, keep going
            var msg = kind + " \"" + name + "\": " + e.Message.Replace("\r", " ").Replace("\n", " ");
            Errors.Add(msg);
            Console.WriteLine("  not exported: " + msg);
        }
    }

    // ---- hardware ----
    private static void CollectDevices(DeviceUserGroupComposition groups, List<Device> into)
    {
        foreach (DeviceUserGroup g in groups)
        {
            into.AddRange(g.Devices);
            CollectDevices(g.Groups, into);
        }
    }

    private static IEnumerable<DeviceItem> AllItems(DeviceItemComposition items)
    {
        foreach (DeviceItem i in items)
        {
            yield return i;
            foreach (var c in AllItems(i.DeviceItems)) yield return c;
        }
    }

    private static void WriteItem(StringBuilder sb, DeviceItem item, ref bool first, int depth)
    {
        if (!first) sb.Append(",");
        first = false;
        sb.Append("\n      {\"name\": ").Append(Js(item.Name))
          .Append(", \"depth\": ").Append(depth)
          .Append(", \"type\": ").Append(Js(Safe(() => item.TypeIdentifier)))
          .Append(", \"position\": ").Append(Js(Safe(() => item.PositionNumber.ToString())))
          .Append(", \"classification\": ").Append(Js(Safe(() => item.Classification.ToString())));

        var addrs = new List<string>();
        try
        {
            foreach (Address a in item.Addresses)
                addrs.Add("{\"io\": " + Js(a.IoType.ToString()) + ", \"start\": " + a.StartAddress + ", \"bits\": " + a.Length + "}");
        }
        catch { }
        sb.Append(", \"addresses\": [").Append(string.Join(", ", addrs)).Append("]");

        try
        {
            var ni = ((IEngineeringServiceProvider)item).GetService<NetworkInterface>();
            if (ni != null)
            {
                var nodes = new List<string>();
                foreach (Node n in ni.Nodes)
                {
                    nodes.Add("{\"ip\": " + Js(Attr(n, "Address")) + ", \"mask\": " + Js(Attr(n, "SubnetMask"))
                        + ", \"pnName\": " + Js(Attr(n, "PnDeviceName"))
                        + ", \"subnet\": " + Js(Safe(() => n.ConnectedSubnet == null ? "" : n.ConnectedSubnet.Name)) + "}");
                }
                sb.Append(", \"nodes\": [").Append(string.Join(", ", nodes)).Append("]");
            }
        }
        catch { }
        sb.Append("}");
        foreach (DeviceItem c in item.DeviceItems) WriteItem(sb, c, ref first, depth + 1);
    }

    // ---- helpers ----
    private static string Attr(IEngineeringObject o, string name)
    {
        try { var v = o.GetAttribute(name); return v == null ? "" : v.ToString(); } catch { return ""; }
    }

    private static string Safe(Func<string> f)
    {
        try { return f() ?? ""; } catch { return ""; }
    }

    private static string FileName(string s)
    {
        var bad = Path.GetInvalidFileNameChars();
        var sb = new StringBuilder();
        foreach (var c in s) sb.Append(bad.Contains(c) ? '_' : c);
        return sb.ToString().TrimEnd('.', ' ');
    }

    private static string Js(string s)
    {
        if (s == null) return "\"\"";
        var sb = new StringBuilder("\"");
        foreach (var c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        return sb.Append("\"").ToString();
    }
}
