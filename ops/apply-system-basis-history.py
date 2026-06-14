from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


path = Path("/home/kyan/apps/nova-server/controllers/maincontroller.js")
text = path.read_text()

text = replace_once(
    text,
    '''  async migrateSystemBasis(req, res) {
    const { token, target, stationId } = req.body || {};''',
    '''  async migrateSystemBasis(req, res) {
    const { token, target, stationId } = req.body || {};
    let migrationRecord = null;''',
    "migration declaration",
)

text = replace_once(
    text,
    '''      if (!station || station.platformID !== platformID) {
        return res.status(404).json({ success: false, message: "Station not found" });
      }
      const packages = (await this.db.getPackagesByPlatformID(platformID)) || [];''',
    '''      if (!station || station.platformID !== platformID) {
        return res.status(404).json({ success: false, message: "Station not found" });
      }
      const sourceBasis = String(station.systemBasis || "API").toUpperCase();
      migrationRecord = await this.db.createPlatformMigration({
        platformID,
        direction: "system_basis",
        status: "running",
        domain: station.name || station.mikrotikHost,
        sourceTarget: sourceBasis,
        destinationTarget: normalizedTarget,
        startedAt: new Date(),
        request: {
          stationId: station.id,
          stationName: station.name || station.mikrotikHost,
          from: sourceBasis,
          to: normalizedTarget,
          requestedBy: {
            id: auth.admin.id || auth.admin.adminID || null,
            name: auth.admin.name || null,
            email: auth.admin.email || null,
          },
        },
      });
      const packages = (await this.db.getPackagesByPlatformID(platformID)) || [];''',
    "migration creation",
)

text = replace_once(
    text,
    '''      await this.refreshDashboardStats(platformID, { role: auth.admin.role });
      return res.json({ success: true, message: `Migration to ${normalizedTarget} completed`, summary });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Migration failed", error: error?.message || error });
    }
  }''',
    '''      await this.refreshDashboardStats(platformID, { role: auth.admin.role });
      const message = `Migration to ${normalizedTarget} completed`;
      const completedMigration = migrationRecord
        ? await this.db.updatePlatformMigration(migrationRecord.id, {
            status: "completed",
            completedAt: new Date(),
            records: summary,
            response: { success: true, message, summary },
            error: null,
          })
        : null;
      return res.json({ success: true, message, summary, migration: completedMigration });
    } catch (error) {
      const message = error?.message || "Migration failed";
      if (migrationRecord?.id) {
        await this.db.updatePlatformMigration(migrationRecord.id, {
          status: "failed",
          completedAt: new Date(),
          error: message,
          response: { success: false, message },
        }).catch(() => null);
      }
      return res.status(500).json({ success: false, message: "Migration failed", error: message });
    }
  }

  async fetchSystemBasisMigrations(req, res) {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ success: false, message: "Missing token" });
    try {
      const auth = await this.auth.AuthenticateRequest(token);
      if (!auth.success || !auth.admin) {
        return res.status(401).json({ success: false, message: auth.message });
      }
      if (auth.admin.role !== "superuser") {
        return res.status(403).json({ success: false, message: "Unauthorised!" });
      }
      const migrations = await this.db.getPlatformMigrations(auth.admin.platformID, 100);
      return res.json({
        success: true,
        migrations: migrations.filter((migration) => migration.direction === "system_basis"),
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to fetch migration history" });
    }
  }''',
    "migration completion and history",
)

path.write_text(text)
