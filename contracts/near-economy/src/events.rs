use near_sdk::{
    env,
    serde_json::{json, Value},
};

pub(crate) fn emit(event: &str, data: Value) {
    let envelope = json!({
        "standard": "fox_economy",
        "version": "1.0.0",
        "event": event,
        "data": [data]
    });
    env::log_str(&format!("EVENT_JSON:{envelope}"));
}
