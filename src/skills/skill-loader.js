const fs = require("fs");
const path = require("path");

class SkillLoader {
  constructor() {
    this.skillsRoot = path.join(
      __dirname,
      "../../agents/skills"
    );

    this.lessonsRoot = path.join(
      __dirname,
      "../../agents/lessons"
    );
  }

  loadSkills(agentId) {
    const agentSkillDir = path.join(
      this.skillsRoot,
      agentId
    );

    if (!fs.existsSync(agentSkillDir)) {
      return "";
    }

    const files = fs
      .readdirSync(agentSkillDir)
      .filter((file) => file.endsWith(".md"))
      .sort();

    return files
      .map((file) => {
        const fullPath = path.join(
          agentSkillDir,
          file
        );

        return fs.readFileSync(
          fullPath,
          "utf8"
        );
      })
      .filter(Boolean)
      .join("\n\n---\n\n");
  }

  loadLessons(agentId) {
    const lessonPath = path.join(
      this.lessonsRoot,
      `${agentId}.md`
    );

    if (!fs.existsSync(lessonPath)) {
      return "";
    }

    return fs.readFileSync(
      lessonPath,
      "utf8"
    );
  }

  buildKnowledgeContext(agentId) {
    const skills = this.loadSkills(agentId);
    const lessons = this.loadLessons(agentId);

    const sections = [];

    if (skills.trim()) {
      sections.push(
        `# AVAILABLE SKILLS\n\n${skills}`
      );
    }

    if (lessons.trim()) {
      sections.push(
        `# LEARNED LESSONS\n\n${lessons}`
      );
    }

    return sections.join("\n\n---\n\n");
  }
}

module.exports = SkillLoader;
