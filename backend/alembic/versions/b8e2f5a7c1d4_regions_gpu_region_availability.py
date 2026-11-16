"""regions + per-SKU regional availability + launch geography

Revision ID: b8e2f5a7c1d4
Revises: a3f7b9c4e2d8
Create Date: 2026-11-17 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'b8e2f5a7c1d4'
down_revision: Union[str, Sequence[str], None] = 'a3f7b9c4e2d8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Schema-only migration — the regions and the (SKU x region) premium
    # matrix are catalogue DATA and are seeded by scripts/seed.py so they stay
    # re-runnable. Additive only.

    op.execute("""
        DO $$ BEGIN
            CREATE TYPE regionstatus AS ENUM ('AVAILABLE', 'DISABLED');
        EXCEPTION
            WHEN duplicate_object THEN NULL;
        END $$;
    """)
    op.execute("""
        DO $$ BEGIN
            CREATE TYPE gpuregionstatus AS ENUM ('AVAILABLE', 'NOT_OFFERED');
        EXCEPTION
            WHEN duplicate_object THEN NULL;
        END $$;
    """)

    _region_status = lambda: postgresql.ENUM(  # noqa: E731
        'AVAILABLE', 'DISABLED', name='regionstatus', create_type=False
    )
    _gpu_region_status = lambda: postgresql.ENUM(  # noqa: E731
        'AVAILABLE', 'NOT_OFFERED', name='gpuregionstatus', create_type=False
    )

    op.create_table(
        'regions',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('aws_region_code', sa.String(length=30), nullable=False),
        sa.Column('public_name', sa.String(length=100), nullable=False),
        sa.Column('country_or_area', sa.String(length=50), nullable=False),
        sa.Column('storage_support', sa.Boolean(), nullable=False, server_default=sa.text('true')),
        sa.Column('ssh_support', sa.Boolean(), nullable=False, server_default=sa.text('true')),
        sa.Column('status', _region_status(), nullable=False, server_default='AVAILABLE'),
    )
    op.create_index('ix_regions_aws_region_code', 'regions', ['aws_region_code'], unique=True)

    op.create_table(
        'gpu_region_availability',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('gpu_type_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('region_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('status', _gpu_region_status(), nullable=False, server_default='AVAILABLE'),
        sa.Column('premium_micros', sa.BigInteger(), nullable=False, server_default=sa.text('0')),
        sa.Column('aws_cost_est_micros_per_hour', sa.BigInteger(), nullable=False, server_default=sa.text('0')),
        sa.Column('ami_id', sa.String(length=50), nullable=True),
        sa.Column('ami_resolved_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['gpu_type_id'], ['gpu_types.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['region_id'], ['regions.id'], ondelete='CASCADE'),
        sa.UniqueConstraint('gpu_type_id', 'region_id', name='uq_gpu_region'),
    )
    op.create_index('ix_gpu_region_availability_gpu_type_id', 'gpu_region_availability', ['gpu_type_id'])
    op.create_index('ix_gpu_region_availability_region_id', 'gpu_region_availability', ['region_id'])

    # Launch geography on the rental (spec §13/§24).
    op.add_column('gpu_instances', sa.Column('region_code', sa.String(length=30), nullable=True))
    op.add_column('gpu_instances', sa.Column('availability_zone', sa.String(length=64), nullable=True))
    op.add_column(
        'gpu_instances',
        sa.Column('regional_premium_micros', sa.BigInteger(), nullable=False, server_default=sa.text('0')),
    )

    # EC2 key pairs are regional — track which regions a key was imported into.
    op.add_column(
        'ssh_keys', sa.Column('aws_key_pair_regions', sa.JSON(), nullable=False, server_default=sa.text("'[]'"))
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('ssh_keys', 'aws_key_pair_regions')
    op.drop_column('gpu_instances', 'regional_premium_micros')
    op.drop_column('gpu_instances', 'availability_zone')
    op.drop_column('gpu_instances', 'region_code')
    op.drop_index('ix_gpu_region_availability_region_id', table_name='gpu_region_availability')
    op.drop_index('ix_gpu_region_availability_gpu_type_id', table_name='gpu_region_availability')
    op.drop_table('gpu_region_availability')
    op.drop_index('ix_regions_aws_region_code', table_name='regions')
    op.drop_table('regions')
    op.execute("DROP TYPE IF EXISTS gpuregionstatus")
    op.execute("DROP TYPE IF EXISTS regionstatus")
