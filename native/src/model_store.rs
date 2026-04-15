use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, ensure};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};

use crate::catalog::ModelCatalog;
use crate::protocol::EngineId;

const INSTALL_METADATA_FILENAME: &str = "install.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelStoreInfo {
    pub override_path: Option<PathBuf>,
    pub path: PathBuf,
    pub using_default_path: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallMetadata {
    pub artifacts: Vec<InstalledArtifact>,
    #[serde(rename = "catalogVersion")]
    pub catalog_version: u32,
    #[serde(rename = "engineId")]
    pub engine_id: EngineId,
    #[serde(rename = "installedAtUnixMs")]
    pub installed_at_unix_ms: u64,
    #[serde(rename = "modelId")]
    pub model_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstalledArtifact {
    pub filename: String,
    pub sha256: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstalledModelRecord {
    #[serde(rename = "catalogVersion")]
    pub catalog_version: u32,
    #[serde(rename = "engineId")]
    pub engine_id: EngineId,
    #[serde(rename = "installPath")]
    pub install_path: String,
    #[serde(rename = "installedAtUnixMs")]
    pub installed_at_unix_ms: u64,
    #[serde(rename = "modelId")]
    pub model_id: String,
    #[serde(rename = "runtimePath")]
    pub runtime_path: Option<String>,
    #[serde(rename = "totalSizeBytes")]
    pub total_size_bytes: u64,
}

pub fn create_install_metadata(
    catalog: &ModelCatalog,
    engine_id: EngineId,
    model_id: &str,
) -> Result<InstallMetadata> {
    let model = catalog
        .find_model(engine_id, model_id)
        .ok_or_else(|| anyhow!("unknown model {}:{model_id}", engine_id.as_str()))?;

    Ok(InstallMetadata {
        artifacts: model
            .artifacts
            .iter()
            .filter(|artifact| artifact.required)
            .map(|artifact| InstalledArtifact {
                filename: artifact.filename.clone(),
                sha256: artifact.sha256.clone(),
                size_bytes: artifact.size_bytes,
            })
            .collect(),
        catalog_version: catalog.catalog_version,
        engine_id,
        installed_at_unix_ms: current_unix_ms()?,
        model_id: model_id.to_string(),
    })
}

pub fn read_install_metadata(install_dir: &Path) -> Result<InstallMetadata> {
    let metadata_path = install_dir.join(INSTALL_METADATA_FILENAME);
    let json = std::fs::read_to_string(&metadata_path)
        .with_context(|| format!("failed to read {}", metadata_path.display()))?;
    serde_json::from_str(&json)
        .with_context(|| format!("failed to parse {}", metadata_path.display()))
}

pub fn resolve_catalog_model_runtime_path(
    catalog: &ModelCatalog,
    model_store_root: &Path,
    engine_id: EngineId,
    model_id: &str,
) -> Result<PathBuf> {
    let install_dir = resolve_model_install_dir(model_store_root, engine_id, model_id);
    let metadata = read_install_metadata(&install_dir)?;
    ensure!(
        metadata.engine_id == engine_id && metadata.model_id == model_id,
        "install metadata does not match {}:{model_id}",
        engine_id.as_str()
    );

    for artifact in &metadata.artifacts {
        let artifact_path = install_dir.join(&artifact.filename);
        ensure!(
            artifact_path.is_file(),
            "required installed artifact is missing: {}",
            artifact_path.display()
        );
    }

    let model = catalog
        .find_model(engine_id, model_id)
        .ok_or_else(|| anyhow!("unknown model {}:{model_id}", engine_id.as_str()))?;
    let primary_artifact = model.primary_artifact().ok_or_else(|| {
        anyhow!(
            "model {}:{model_id} is missing a transcription artifact",
            engine_id.as_str()
        )
    })?;
    let runtime_path = install_dir.join(&primary_artifact.filename);

    ensure!(
        runtime_path.is_file(),
        "runtime model file is missing: {}",
        runtime_path.display()
    );

    Ok(runtime_path)
}

pub fn resolve_model_install_dir(
    model_store_root: &Path,
    engine_id: EngineId,
    model_id: &str,
) -> PathBuf {
    model_store_root.join(engine_id.as_str()).join(model_id)
}

pub fn resolve_model_store_info(model_store_path_override: Option<&str>) -> Result<ModelStoreInfo> {
    match model_store_path_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(override_value) => {
            let override_path = PathBuf::from(override_value);
            ensure!(
                override_path.is_absolute(),
                "Model store override must be an absolute path."
            );

            Ok(ModelStoreInfo {
                override_path: Some(override_path.clone()),
                path: override_path,
                using_default_path: false,
            })
        }
        None => {
            let project_dirs = ProjectDirs::from("", "", "obsidian-local-stt")
                .ok_or_else(|| anyhow!("failed to resolve the default model store directory"))?;
            let path = project_dirs.data_local_dir().join("models");

            Ok(ModelStoreInfo {
                override_path: None,
                path,
                using_default_path: true,
            })
        }
    }
}

pub fn remove_installed_model(
    model_store_root: &Path,
    engine_id: EngineId,
    model_id: &str,
) -> Result<bool> {
    let install_dir = resolve_model_install_dir(model_store_root, engine_id, model_id);

    if !install_dir.exists() {
        return Ok(false);
    }

    std::fs::remove_dir_all(&install_dir)
        .with_context(|| format!("failed to remove {}", install_dir.display()))?;
    Ok(true)
}

pub fn scan_installed_models(
    catalog: &ModelCatalog,
    model_store_root: &Path,
) -> Result<Vec<InstalledModelRecord>> {
    let mut installed_models = Vec::new();

    if !model_store_root.exists() {
        return Ok(installed_models);
    }

    for engine_entry in std::fs::read_dir(model_store_root)
        .with_context(|| format!("failed to read {}", model_store_root.display()))?
    {
        let engine_entry = engine_entry?;
        let engine_path = engine_entry.path();

        if !engine_path.is_dir() {
            continue;
        }

        for model_entry in std::fs::read_dir(&engine_path)
            .with_context(|| format!("failed to read {}", engine_path.display()))?
        {
            let model_entry = model_entry?;
            let install_dir = model_entry.path();

            if !install_dir.is_dir() {
                continue;
            }

            let metadata = match read_install_metadata(&install_dir) {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };

            if metadata
                .artifacts
                .iter()
                .any(|artifact| !install_dir.join(&artifact.filename).is_file())
            {
                continue;
            }

            let runtime_path = catalog
                .find_model(metadata.engine_id, &metadata.model_id)
                .and_then(|model| model.primary_artifact())
                .map(|artifact| install_dir.join(&artifact.filename))
                .filter(|path| path.is_file());

            installed_models.push(InstalledModelRecord {
                catalog_version: metadata.catalog_version,
                engine_id: metadata.engine_id,
                install_path: install_dir.display().to_string(),
                installed_at_unix_ms: metadata.installed_at_unix_ms,
                model_id: metadata.model_id,
                runtime_path: runtime_path.map(|path| path.display().to_string()),
                total_size_bytes: metadata
                    .artifacts
                    .iter()
                    .map(|artifact| artifact.size_bytes)
                    .sum(),
            });
        }
    }

    installed_models.sort_by(|left, right| left.model_id.cmp(&right.model_id));
    Ok(installed_models)
}

pub fn write_install_metadata(install_dir: &Path, metadata: &InstallMetadata) -> Result<()> {
    std::fs::create_dir_all(install_dir)
        .with_context(|| format!("failed to create {}", install_dir.display()))?;
    let metadata_path = install_dir.join(INSTALL_METADATA_FILENAME);
    let json =
        serde_json::to_string_pretty(metadata).context("failed to serialize install metadata")?;
    std::fs::write(&metadata_path, json)
        .with_context(|| format!("failed to write {}", metadata_path.display()))?;
    Ok(())
}

fn current_unix_ms() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock moved backwards")?
        .as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use std::fs::{create_dir_all, write};

    use super::{
        InstallMetadata, InstalledArtifact, read_install_metadata, resolve_model_store_info,
        scan_installed_models, write_install_metadata,
    };
    use crate::catalog::{
        ArtifactRole, CatalogModel, ModelArtifact, ModelCatalog, ModelCollection, ModelEngine,
    };
    use crate::protocol::EngineId;

    #[test]
    fn resolve_model_store_info_uses_absolute_override() {
        let info = resolve_model_store_info(Some("/tmp/obsidian-local-stt-models"))
            .expect("override should resolve");

        assert_eq!(
            info.path,
            std::path::PathBuf::from("/tmp/obsidian-local-stt-models")
        );
        assert!(!info.using_default_path);
    }

    #[test]
    fn write_and_read_install_metadata_round_trip() {
        let temp_dir = tempfile_dir("metadata");
        let metadata = InstallMetadata {
            artifacts: vec![InstalledArtifact {
                filename: "model.bin".to_string(),
                sha256: "abc".to_string(),
                size_bytes: 42,
            }],
            catalog_version: 1,
            engine_id: EngineId::WhisperCpp,
            installed_at_unix_ms: 99,
            model_id: "small".to_string(),
        };

        write_install_metadata(&temp_dir, &metadata).expect("metadata should write");
        let loaded = read_install_metadata(&temp_dir).expect("metadata should read");

        assert_eq!(loaded, metadata);
    }

    #[test]
    fn scan_installed_models_ignores_missing_artifacts() {
        let temp_dir = tempfile_dir("scan");
        let install_dir = temp_dir.join("whisper_cpp").join("small");
        create_dir_all(&install_dir).expect("install dir should create");
        write_install_metadata(
            &install_dir,
            &InstallMetadata {
                artifacts: vec![InstalledArtifact {
                    filename: "missing.bin".to_string(),
                    sha256: "abc".to_string(),
                    size_bytes: 10,
                }],
                catalog_version: 1,
                engine_id: EngineId::WhisperCpp,
                installed_at_unix_ms: 10,
                model_id: "small".to_string(),
            },
        )
        .expect("metadata should write");

        let installed =
            scan_installed_models(&sample_catalog(), &temp_dir).expect("scan should succeed");

        assert!(installed.is_empty());
    }

    fn sample_catalog() -> ModelCatalog {
        ModelCatalog {
            catalog_version: 1,
            collections: vec![ModelCollection {
                collection_id: "english".to_string(),
                display_name: "English".to_string(),
                summary: "summary".to_string(),
            }],
            engines: vec![ModelEngine {
                display_name: "Whisper.cpp".to_string(),
                engine_id: EngineId::WhisperCpp,
                summary: "summary".to_string(),
            }],
            models: vec![CatalogModel {
                artifacts: vec![ModelArtifact {
                    artifact_id: "transcription".to_string(),
                    download_url: "https://example.com/model.bin".to_string(),
                    filename: "model.bin".to_string(),
                    required: true,
                    role: ArtifactRole::TranscriptionModel,
                    sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                        .to_string(),
                    size_bytes: 10,
                }],
                capability_flags: vec![],
                collection_id: "english".to_string(),
                display_name: "Model".to_string(),
                engine_id: EngineId::WhisperCpp,
                language_tags: vec!["en".to_string()],
                license_label: "MIT".to_string(),
                license_url: "https://example.com/license".to_string(),
                model_card_url: None,
                model_id: "small".to_string(),
                notes: vec![],
                source_url: "https://example.com".to_string(),
                summary: "summary".to_string(),
                ux_tags: vec![],
            }],
        }
    }

    fn tempfile_dir(prefix: &str) -> std::path::PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "obsidian-local-stt-sidecar-{prefix}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should move forward")
                .as_nanos()
        ));
        create_dir_all(&directory).expect("temp dir should create");
        write(directory.join("README"), b"").expect("temp dir should be writable");
        std::fs::remove_file(directory.join("README")).expect("temp file should remove");
        directory
    }
}
