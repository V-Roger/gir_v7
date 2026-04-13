import { defineField, defineType } from "sanity";

export default defineType({
  name: "gallery",
  title: "Gallery",
  type: "document",
  fields: [
    defineField({
      name: "title",
      title: "Title",
      type: "string",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "slug",
      title: "Slug",
      type: "slug",
      options: { source: "title", maxLength: 96 },
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "description",
      title: "Description",
      type: "markdown",
      description: "GitHub-flavored Markdown; supports images via drag-and-drop or paste.",
    }),
    defineField({
      name: "photos",
      title: "Photos",
      type: "array",
      of: [{ type: "reference", to: [{ type: "photo" }] }],
    }),
    defineField({
      name: "exhibitions",
      title: "Exhibitions",
      type: "array",
      of: [{ type: "reference", to: [{ type: "exhibition" }] }],
    }),
    defineField({
      name: "publications",
      title: "Publications",
      type: "array",
      of: [{ type: "reference", to: [{ type: "publication" }] }],
    }),
    defineField({
      name: "priority",
      title: "Priority",
      type: "number",
      initialValue: 0,
      validation: (Rule) => Rule.required(),
    }),
  ],
  preview: {
    select: { title: "title" },
  },
});
