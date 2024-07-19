// Unless explicitly stated otherwise all files in this repository are licensed under the Apache License, Version 2.0.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2024 Datadog, Inc.

use common::model::diff_aware::DiffAware;
use sds::{MatchAction, RuleConfig};
use serde::{Deserialize, Serialize};

// This is the secret rule exposed by SDS
#[derive(Clone, Deserialize, Debug, Serialize)]
pub struct SecretRule {
    pub id: String,
    pub name: String,
    pub description: String,
    pub pattern: String,
}

impl SecretRule {
    /// Convert the rule into a configuration usable by SDS.
    pub fn convert_to_sds_ruleconfig(&self) -> RuleConfig {
        RuleConfig::builder(&self.pattern)
            .match_action(MatchAction::None)
            .build()
    }
}

impl DiffAware for SecretRule {
    fn generate_diff_aware_digest(&self) -> String {
        format!("{}:{}", self.id, self.pattern).to_string()
    }
}