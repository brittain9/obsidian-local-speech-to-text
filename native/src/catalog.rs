use std::collections::HashSet;
use std::path::{Component, Path};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};

use crate::protocol::EngineId;

const BUNDLED_CATALOG_JSON: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/catalog.json"));

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelCatalog {
    #[serde(rename = "catalogVersion")]
    pub catalog_version: u32,
    pub collections: Vec<ModelCollection>,
    pub engines: Vec<ModelEngine>,
    pub models: Vec<CatalogModel>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelEngine {
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(rename = "engineId")]
    pub engine_id: EngineId,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelCollection {
    #[serde(rename = "collectionId")]
    pub collection_id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogModel {
    pub artifacts: Vec<ModelArtifact>,
    #[serde(rename = "capabilityFlags")]
    pub capability_flags: Vec<String>,
    #[serde(rename = "collectionId")]
    pub collection_id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(rename = "engineId")]
    pub engine_id: EngineId,
    #[serde(rename = "languageTags")]
    pub language_tags: Vec<String>,
    #[serde(rename = "licenseLabel")]
    pub license_label: String,
    #[serde(rename = "licenseUrl")]
    pub license_url: String,
    #[serde(rename = "modelCardUrl")]
    pub model_card_url: Option<String>,
    #[serde(rename = "modelId")]
    pub model_id: String,
    pub notes: Vec<String>,
    #[serde(rename = "sourceUrl")]
    pub source_url: String,
    pub summary: String,
    #[serde(rename = "uxTags")]
    pub ux_tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelArtifact {
    #[serde(rename = "artifactId")]
    pub artifact_id: String,
    #[serde(rename = "downloadUrl")]
    pub download_url: String,
    pub filename: String,
    pub required: bool,
    pub role: ArtifactRole,
    pub sha256: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactRole {
    SupportingFile,
    TranscriptionModel,
}

impl ModelCatalog {
    pub fn load_bundled() -> Result<Self> {
        let catalog: Self = serde_json::from_str(BUNDLED_CATALOG_JSON)
            .context("failed to parse bundled model catalog")?;
        catalog.validate()?;
        Ok(catalog)
    }

    pub fn find_model(&self, engine_id: EngineId, model_id: &str) -> Option<&CatalogModel> {
        self.models
            .iter()
            .find(|model| model.engine_id == engine_id && model.model_id == model_id)
    }

    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.catalog_version > 0,
            "catalogVersion must be a positive integer"
        );

        let mut engine_ids = HashSet::new();

        for engine in &self.engines {
            ensure!(
                engine_ids.insert(engine.engine_id),
                "duplicate engineId {}",
                engine.engine_id.as_str()
            );
            ensure!(
                !engine.display_name.trim().is_empty(),
                "engine displayName must not be empty"
            );
        }

        let mut collection_ids = HashSet::new();

        for collection in &self.collections {
            ensure!(
                collection_ids.insert(collection.collection_id.clone()),
                "duplicate collectionId {}",
                collection.collection_id
            );
            ensure!(
                !collection.display_name.trim().is_empty(),
                "collection displayName must not be empty"
            );
        }

        let mut model_keys = HashSet::new();

        for model in &self.models {
            ensure!(
                engine_ids.contains(&model.engine_id),
                "model {} references unknown engineId {}",
                model.model_id,
                model.engine_id.as_str()
            );
            ensure!(
                collection_ids.contains(&model.collection_id),
                "model {} references unknown collectionId {}",
                model.model_id,
                model.collection_id
            );
            ensure!(
                model_keys.insert((model.engine_id, model.model_id.clone())),
                "duplicate modelId {} for engine {}",
                model.model_id,
                model.engine_id.as_str()
            );

            let mut artifact_ids = HashSet::new();
            let mut has_transcription_artifact = false;

            for artifact in &model.artifacts {
                ensure!(
                    artifact_ids.insert(artifact.artifact_id.clone()),
                    "duplicate artifactId {} for model {}",
                    artifact.artifact_id,
                    model.model_id
                );
                ensure!(
                    artifact.size_bytes > 0,
                    "artifact {} for model {} must have a positive sizeBytes",
                    artifact.artifact_id,
                    model.model_id
                );
                ensure!(
                    is_valid_sha256(&artifact.sha256),
                    "artifact {} for model {} has an invalid sha256",
                    artifact.artifact_id,
                    model.model_id
                );
                ensure!(
                    artifact.download_url.starts_with("https://"),
                    "artifact {} for model {} must use an https downloadUrl",
                    artifact.artifact_id,
                    model.model_id
                );
                ensure!(
                    is_safe_relative_path(&artifact.filename),
                    "artifact {} for model {} must use a safe relative filename",
                    artifact.artifact_id,
                    model.model_id
                );

                if artifact.required && artifact.role == ArtifactRole::TranscriptionModel {
                    has_transcription_artifact = true;
                }
            }

            ensure!(
                has_transcription_artifact,
                "model {} must declare a required transcription_model artifact",
                model.model_id
            );
        }

        Ok(())
    }
}

impl CatalogModel {
    pub fn required_download_bytes(&self) -> u64 {
        self.artifacts
            .iter()
            .filter(|artifact| artifact.required)
            .map(|artifact| artifact.size_bytes)
            .sum()
    }

    pub fn primary_artifact(&self) -> Option<&ModelArtifact> {
        self.artifacts
            .iter()
            .find(|artifact| artifact.required && artifact.role == ArtifactRole::TranscriptionModel)
    }
}

fn is_safe_relative_path(value: &str) -> bool {
    let path = Path::new(value);

    if path.is_absolute() {
        return false;
    }

    let mut has_normal_component = false;

    for component in path.components() {
        match component {
            Component::Normal(_) => has_normal_component = true,
            Component::CurDir => continue,
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => return false,
        }
    }

    has_normal_component
}

fn is_valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::{
        ArtifactRole, CatalogModel, ModelArtifact, ModelCatalog, ModelCollection, ModelEngine,
    };
    use crate::protocol::EngineId;

    #[test]
    fn bundled_catalog_is_valid() {
        ModelCatalog::load_bundled().expect("bundled catalog should parse and validate");
    }

    #[test]
    fn validate_rejects_duplicate_engine_ids() {
        let error = ModelCatalog {
            catalog_version: 1,
            collections: vec![sample_collection()],
            engines: vec![sample_engine(), sample_engine()],
            models: vec![sample_model()],
        }
        .validate()
        .expect_err("catalog should fail");

        assert!(error.to_string().contains("duplicate engineId"));
    }

    #[test]
    fn validate_rejects_invalid_artifact_paths() {
        let mut model = sample_model();
        model.artifacts[0].filename = "../model.bin".to_string();

        let error = ModelCatalog {
            catalog_version: 1,
            collections: vec![sample_collection()],
            engines: vec![sample_engine()],
            models: vec![model],
        }
        .validate()
        .expect_err("catalog should fail");

        assert!(
            error
                .to_string()
                .contains("must use a safe relative filename")
        );
    }

    fn sample_engine() -> ModelEngine {
        ModelEngine {
            display_name: "Whisper.cpp".to_string(),
            engine_id: EngineId::WhisperCpp,
            summary: "summary".to_string(),
        }
    }

    fn sample_collection() -> ModelCollection {
        ModelCollection {
            collection_id: "english".to_string(),
            display_name: "English".to_string(),
            summary: "summary".to_string(),
        }
    }

    fn sample_model() -> CatalogModel {
        CatalogModel {
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
            capability_flags: vec!["dictation".to_string()],
            collection_id: "english".to_string(),
            display_name: "Model".to_string(),
            engine_id: EngineId::WhisperCpp,
            language_tags: vec!["en".to_string()],
            license_label: "MIT".to_string(),
            license_url: "https://example.com/license".to_string(),
            model_card_url: None,
            model_id: "model".to_string(),
            notes: vec![],
            source_url: "https://example.com".to_string(),
            summary: "summary".to_string(),
            ux_tags: vec![],
        }
    }
}
