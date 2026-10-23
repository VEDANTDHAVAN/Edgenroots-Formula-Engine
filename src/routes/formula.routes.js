const router = require("express").Router();
const controller = require("../controllers/formula.controller");

// Preview routes come first so `preview` is never parsed as a UUID parameter.
router.post("/preview/bulk", controller.bulk);
router.post("/preview", controller.preview);

router.post("/", controller.create);
router.get("/", controller.list);

router.get("/:uuid/history", controller.history);
router.get("/:uuid/impact", controller.impact);
router.post("/:uuid/deactivate", controller.deactivate);
router.post("/:uuid/rollback", controller.rollback);

module.exports = router;
