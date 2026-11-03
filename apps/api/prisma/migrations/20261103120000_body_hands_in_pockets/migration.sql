-- La foto del modelo tiene las manos en los bolsillos: la IA no le cambia la parte de abajo.
ALTER TABLE "BodyModel" ADD COLUMN "handsInPockets" BOOLEAN NOT NULL DEFAULT false;
