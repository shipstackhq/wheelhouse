/** A document that exercises the Markdown the editor must keep: headings 1 to 6, inline HTML, aligned tables, images with titles, dividers. */
export const PASTED = `# Heading Level 1 (H1)
## Heading Level 2 (H2)
### Heading Level 3 (H3)
#### Heading Level 4 (H4)
##### Heading Level 5 (H5)
###### Heading Level 6 (H6)

---

### Custom & Inline Text Sizes (HTML in Markdown)

Markdown doesn't have native font-size tags beyond headings, but supports standard inline HTML:

- Normal body text size
- <small>Small text (\`<small>\` tag)</small>
- <span style="font-size: 0.8em;">Subtle small text (80% / 0.8em)</span>
- <span style="font-size: 1.25em;">Slightly larger emphasis text (125% / 1.25em)</span>
- <span style="font-size: 1.6em; font-weight: bold;">Large highlight text (1.6em)</span>

---

### Tables

#### 1. Feature Comparison Table

| Feature | Basic Plan | Pro Plan | Enterprise |
| :--- | :---: | :---: | :---: |
| Cloud Storage | 10 GB | 1 TB | Unlimited |
| Priority Support | ❌ | 24/7 Chat | Dedicated Rep |
| API Access | Limited | Standard | Full / Custom |
| Monthly Price | **$0** | **$19** | **Custom** |

#### 2. Team Task Tracker

| Task ID | Description | Assignee | Status | Due Date |
| :--- | :--- | :--- | :--- | :--- |
| \`TSK-101\` | Setup repository structure | Alex M. | \`Done\` | Oct 12, 2026 |
| \`TSK-102\` | Implement authentication API | Sarah K. | \`In Review\` | Oct 18, 2026 |
| \`TSK-103\` | Design analytics dashboard | Liam T. | \`In Progress\` | Oct 25, 2026 |
| \`TSK-104\` | Deploy staging cluster | DevOps | \`Pending\` | Nov 02, 2026 |

---

### Embedded Image

Standard Markdown image syntax: \`![Alt Text](URL "Optional Title")\`

![Hubble Deep Field](https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=1000&q=80 "Cosmic View")

*Figure: Satellite and planetary view from low Earth orbit.*`;
